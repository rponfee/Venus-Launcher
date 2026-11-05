param(
  [Parameter(Mandatory = $true)][string]$PgBin,
  [ValidateRange(49152, 65535)][int]$Port = 54441
)
# 0045 (Soporte) sobre 0001..0037, solo PostgreSQL portátil local y datos ficticios.
# Ejemplo: .\scripts\run-support-local.ps1 -PgBin "$env:TEMP\venus-sql-pg17-20261103\pgsql\bin"
# Arma BEGIN; <0045>; <supabase/tests/soporte-local.sql>; ROLLBACK; y comprueba que las 156 comprobaciones pasan y que
# el esquema quedó igual que antes. Apaga su propio cluster al terminar. No instala dependencias.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$PgBin = (Resolve-Path -LiteralPath $PgBin).Path
if (-not $PgBin.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase)) { throw 'Usar solo binarios portátiles dentro de TEMP.' }
foreach ($name in @('initdb', 'pg_ctl', 'psql', 'pg_dump')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PgBin ($name + '.exe')))) { throw "Falta $name.exe" }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } finally { $listener.Stop() }
$run = Join-Path $taskTemp ('venus-support-sql-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $run | Out-Null
Write-Output "Evidencia local: $run"
$utf8 = [Text.UTF8Encoding]::new($false)
$nl = [Environment]::NewLine
function Write-TaskFile([string]$Path, [string]$Text) { [IO.File]::WriteAllText($Path, ($Text -replace '\r?\n', $nl), $utf8) }
function Invoke-LocalNative([string]$Exe, [string[]]$Arguments, [string]$Log) {
  # PowerShell 5 convierte stderr (incluso NOTICE de PostgreSQL) en ErrorRecord: el criterio es el código de salida.
  $saved = $ErrorActionPreference
  try { $ErrorActionPreference = 'Continue'; & $Exe @Arguments *> $Log; $code = $LASTEXITCODE } finally { $ErrorActionPreference = $saved }
  if ($code -ne 0) { Get-Content -LiteralPath $Log -Tail 35 | Write-Output; throw "Error $code en $Exe; evidencia: $Log" }
}
$baseline = @(Get-ChildItem -LiteralPath (Join-Path $repo 'supabase\migrations') -File |
  Where-Object Name -Match '^00(?:0[1-9]|[12][0-9]|3[0-7])_.*\.sql$' | Sort-Object Name)
if ($baseline.Count -ne 37) { throw 'Se requieren las 37 migraciones base completas.' }
$fixture = Join-Path $repo 'supabase\tests\fixtures\managed-schemas-minimal.sql'
$migration = Join-Path $repo 'supabase\migrations\0045_soporte_mejoras.sql'
$test = Join-Path $repo 'supabase\tests\soporte-local.sql'
$baseSql = 'BEGIN;' + $nl + (($baseline | ForEach-Object { '-- ' + $_.Name + $nl + [IO.File]::ReadAllText($_.FullName) }) -join $nl) + $nl + 'COMMIT;' + $nl
Write-TaskFile (Join-Path $run 'baseline.sql') $baseSql
$combined = 'BEGIN;' + $nl + "SET LOCAL lock_timeout = '5s';" + $nl + "SET LOCAL statement_timeout = '120s';" + $nl +
  [IO.File]::ReadAllText($migration) + $nl + [IO.File]::ReadAllText($test) + $nl + 'ROLLBACK;' + $nl
Write-TaskFile (Join-Path $run 'combined.sql') $combined
$connection = @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'venus_sql_test', '-w')
$psql = Join-Path $PgBin 'psql.exe'
$dump = Join-Path $PgBin 'pg_dump.exe'
$ctl = Join-Path $PgBin 'pg_ctl.exe'
$data = Join-Path $run 'data'
$started = $false
try {
  Invoke-LocalNative (Join-Path $PgBin 'initdb.exe') @('-D', $data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C') (Join-Path $run 'initdb.log')
  $config = $nl + "listen_addresses = '127.0.0.1'" + $nl + "port = $Port" + $nl + 'max_connections = 12' + $nl + "shared_buffers = '32MB'" + $nl + "timezone = 'UTC'" + $nl
  [IO.File]::AppendAllText((Join-Path $data 'postgresql.conf'), $config, $utf8)
  Write-TaskFile (Join-Path $data 'pg_hba.conf') ('host all all 127.0.0.1/32 trust' + $nl)
  $startArgs = '-D "' + $data + '" -l "' + (Join-Path $run 'postgres.log') + '" -w -t 20 start'
  $starter = Start-Process -FilePath $ctl -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'start.log') -RedirectStandardError (Join-Path $run 'start-error.log')
  # PowerShell 5 pierde el código de salida de un proceso que no cacheó su handle: se lo toca antes de esperar.
  $null = $starter.Handle
  if (-not $starter.WaitForExit(30000)) { throw 'pg_ctl no terminó en 30 segundos.' }
  if ($starter.ExitCode -ne 0) { throw 'No pudo iniciar el cluster temporal; revisar start-error.log.' }
  $started = $true
  Invoke-LocalNative $psql @('-X', '-w', '-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE venus_sql_test') (Join-Path $run 'create.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', $fixture)) (Join-Path $run 'fixtures.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'baseline.sql'))) (Join-Path $run 'baseline.log')
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-before.sql'))) (Join-Path $run 'dump-before.log')
  $testError = $null
  try { Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'combined.sql'))) (Join-Path $run 'test.log') } catch { $testError = $_ }
  # Si una comprobación falla, psql corta la conexión y PostgreSQL revierte la transacción: el esquema tiene que quedar igual.
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-after.sql'))) (Join-Path $run 'dump-after.log')
  $strip = '(?m)^\\(?:un)?restrict .*\r?\n'
  $schemaRestored = ([IO.File]::ReadAllText((Join-Path $run 'schema-before.sql')) -replace $strip, '') -ceq ([IO.File]::ReadAllText((Join-Path $run 'schema-after.sql')) -replace $strip, '')
  $testLog = [IO.File]::ReadAllText((Join-Path $run 'test.log'))
  $match = [regex]::Match($testLog, 'SOPORTE_CHECKS=(\d+)')
  $checks = if ($match.Success) { [int]$match.Groups[1].Value } else { 0 }
  $ok = $null -eq $testError -and $checks -gt 0 -and $schemaRestored
  $summary = [ordered]@{ ok = $ok; environment = 'PostgreSQL local; fixtures parciales de Supabase'; baselineMigrations = 37; tested = '0045'; checks = $checks; schemaRestored = $schemaRestored; evidence = $run }
  Write-TaskFile (Join-Path $run 'result.json') (($summary | ConvertTo-Json) + $nl)
  Get-Content -LiteralPath (Join-Path $run 'test.log') -Tail 8
  $summary | ConvertTo-Json
  if ($testError) { throw $testError }
  if (-not $ok) { throw 'Falló una comprobación o el esquema no volvió a su estado; revisar result.json.' }
} finally {
  if ($started -or (Test-Path -LiteralPath (Join-Path $data 'postmaster.pid'))) {
    Invoke-LocalNative $ctl @('-D', $data, '-m', 'fast', '-w', '-t', '20', 'stop') (Join-Path $run 'stop.log')
    Write-Output 'PostgreSQL temporal detenido; evidencia conservada en TEMP.'
  }
}
