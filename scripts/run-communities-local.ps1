param(
  [Parameter(Mandatory = $true)][string]$PgBin,
  [ValidateRange(49152, 65535)][int]$Port = 54440
)
# 0038 sobre 0001..0037 completas, solo PostgreSQL portátil local y datos ficticios.
# Ejemplo: .\scripts\run-communities-local.ps1 -PgBin "$env:TEMP\venus-sql-pg17-20261103\pgsql\bin"
# No instala dependencias. Conserva evidencia en TEMP y apaga su propio cluster en finally.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$PgBin = (Resolve-Path -LiteralPath $PgBin).Path
if (-not $PgBin.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Usar solo binarios portátiles dentro de TEMP.'
}
foreach ($name in @('initdb', 'pg_ctl', 'psql', 'pg_dump')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PgBin ($name + '.exe')))) { throw "Falta $name.exe" }
}
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } finally { $listener.Stop() }
$run = Join-Path $taskTemp ('venus-communities-sql-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $run | Out-Null
Write-Output "Evidencia local: $run"
$utf8 = [Text.UTF8Encoding]::new($false)
$nl = [Environment]::NewLine
function Write-TaskFile([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -replace '\r?\n', $nl), $utf8)
}
function Invoke-LocalNative([string]$Exe, [string[]]$Arguments, [string]$Log) {
  # PowerShell 5 convierte stderr (incluso NOTICE de PostgreSQL) en ErrorRecord.
  # El criterio de fallo es el código de salida del proceso, conservando ambos canales.
  $savedPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $Exe @Arguments *> $Log
    $nativeExit = $LASTEXITCODE
  } finally { $ErrorActionPreference = $savedPreference }
  if ($nativeExit -ne 0) {
    Get-Content -LiteralPath $Log -Tail 35 | Write-Output
    throw "Error $nativeExit en $Exe; evidencia: $Log"
  }
}
$baseline = @(Get-ChildItem -LiteralPath (Join-Path $repo 'supabase\migrations') -File |
  Where-Object Name -Match '^00(?:0[1-9]|[12][0-9]|3[0-7])_.*\.sql$' | Sort-Object Name)
if ($baseline.Count -ne 37) { throw 'Se requieren las 37 migraciones base completas.' }
for ($i = 1; $i -le 37; $i++) {
  if (-not $baseline[$i - 1].Name.StartsWith(('{0:D4}_' -f $i))) { throw 'Orden de migraciones base inesperado.' }
}
$test = Join-Path $repo 'supabase\tests\communities-local.sql'
$fixture = Join-Path $repo 'supabase\tests\fixtures\managed-schemas-minimal.sql'
$tracked = @($baseline.FullName) + @(
  (Join-Path $repo 'supabase\migrations\0038_comunidades.sql'), $fixture, $test, $PSCommandPath
)
$beforeHashes = @($tracked | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 })
$beforeHashes | Select-Object Path, Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'inputs.json') -Encoding utf8
$baseSql = 'BEGIN;' + $nl + (($baseline | ForEach-Object {
  '-- ' + $_.Name + $nl + [IO.File]::ReadAllText($_.FullName)
}) -join $nl) + $nl + 'COMMIT;' + $nl
Write-TaskFile (Join-Path $run 'baseline.sql') $baseSql

# Solo hashes y cantidades del estado local, incluidas secuencias.
$stateSql = @'
SET statement_timeout = '30s';
SET timezone = 'UTC';
CREATE FUNCTION pg_temp.venus_fixture_state() RETURNS jsonb LANGUAGE plpgsql AS $state$
declare r record; v jsonb; result jsonb := '{}'::jsonb;
begin
  for r in select n.nspname, c.relname, c.relkind
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private','auth','storage','realtime','vault') and c.relkind in ('r','S')
    order by n.nspname,c.relname loop
    if r.relkind = 'S' then
      execute format('select jsonb_build_object(''last'',last_value,''called'',is_called) from %I.%I',r.nspname,r.relname) into v;
    else
      execute format('select jsonb_build_object(''rows'',count(*),''md5'',md5(coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text)::text,''[]''))) from %I.%I x',r.nspname,r.relname) into v;
    end if;
    result := result || jsonb_build_object(r.nspname||'.'||r.relname,v);
  end loop;
  return result;
end $state$;
SELECT pg_temp.venus_fixture_state();
'@
Write-TaskFile (Join-Path $run 'state.sql') $stateSql
$connection = @('-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'venus_sql_test', '-w')
$psql = Join-Path $PgBin 'psql.exe'
$dump = Join-Path $PgBin 'pg_dump.exe'
$ctl = Join-Path $PgBin 'pg_ctl.exe'
$data = Join-Path $run 'data'
$started = $false
try {
  Invoke-LocalNative (Join-Path $PgBin 'initdb.exe') @('-D', $data, '-U', 'postgres', '--auth=trust', '--encoding=UTF8', '--locale=C') (Join-Path $run 'initdb.log')
  $config = $nl + "listen_addresses = '127.0.0.1'" + $nl + "port = $Port" + $nl +
    "wal_level = logical" + $nl + "max_connections = 12" + $nl + "shared_buffers = '32MB'" + $nl + "timezone = 'UTC'" + $nl
  [IO.File]::AppendAllText((Join-Path $data 'postgresql.conf'), $config, $utf8)
  Write-TaskFile (Join-Path $data 'pg_hba.conf') ('host all all 127.0.0.1/32 trust' + $nl)
  # Espera solo al iniciador: no heredar una tubería de PowerShell en el servidor.
  $startArgs = '-D "' + $data + '" -l "' + (Join-Path $run 'postgres.log') + '" -w -t 20 start'
  $starter = Start-Process -FilePath $ctl -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'start.log') -RedirectStandardError (Join-Path $run 'start-error.log')
  if (-not $starter.WaitForExit(30000)) { throw 'pg_ctl no terminó en 30 segundos.' }
  if ($starter.ExitCode -ne 0) { throw 'No pudo iniciar el cluster temporal; revisar start-error.log.' }
  $started = $true
  Invoke-LocalNative $psql @('-X', '-w', '-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE venus_sql_test') (Join-Path $run 'create.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', $fixture)) (Join-Path $run 'fixtures.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'baseline.sql'))) (Join-Path $run 'baseline.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c',
    "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net')")) (Join-Path $run 'pg-net.log')
  $pgNetInstalled = ([IO.File]::ReadAllText((Join-Path $run 'pg-net.log')).Trim() -eq 't')
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-before.sql'))) (Join-Path $run 'dump-before.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'state.sql'))) (Join-Path $run 'state-before.json')
  $testError = $null
  try {
    Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-v', 'venus_disposable=on', '-f', $test)) (Join-Path $run 'test.log')
  } catch { $testError = $_ }
  # Incluso si una aserción falla, psql cierra la conexión y PostgreSQL revierte la transacción.
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-after.sql'))) (Join-Path $run 'dump-after.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'state.sql'))) (Join-Path $run 'state-after.json')
  $schemaBefore = [IO.File]::ReadAllText((Join-Path $run 'schema-before.sql')) -replace '(?m)^\\(?:un)?restrict .*\r?\n', ''
  $schemaAfter = [IO.File]::ReadAllText((Join-Path $run 'schema-after.sql')) -replace '(?m)^\\(?:un)?restrict .*\r?\n', ''
  $schemaRestored = $schemaBefore -ceq $schemaAfter
  $rowsRestored = [IO.File]::ReadAllText((Join-Path $run 'state-before.json')) -ceq [IO.File]::ReadAllText((Join-Path $run 'state-after.json'))
  $inputsUnchanged = $true
  foreach ($inputFile in $beforeHashes) {
    if ((Get-FileHash -LiteralPath $inputFile.Path -Algorithm SHA256).Hash -ne $inputFile.Hash) {
      $inputsUnchanged = $false
      Write-Warning "El archivo cambió durante el ensayo: $($inputFile.Path)"
    }
  }
  $testLog = [IO.File]::ReadAllText((Join-Path $run 'test.log'))
  $checkMatch = [regex]::Match($testLog, 'COMMUNITIES_CHECKS=(\d+)')
  $checks = if ($checkMatch.Success) { [int]$checkMatch.Groups[1].Value } else { 0 }
  $rollbackMarker = $testLog.Contains('COMMUNITIES_ROLLBACK_OK')
  $ok = $null -eq $testError -and $checks -gt 0 -and $rollbackMarker -and $schemaRestored -and $rowsRestored -and $inputsUnchanged
  $summary = [ordered]@{
    ok = $ok; environment = 'PostgreSQL local; fixtures parciales de Supabase'
    baselineMigrations = 37; rollbackMigration = '0038'; checks = $checks
    schemaAndAclRestored = $schemaRestored; rowsAndSequencesRestored = $rowsRestored; inputsUnchanged = $inputsUnchanged
    vault = 'Catálogo mínimo vacío; no se consultan ni escriben secretos'
    pgNetInstalled = $pgNetInstalled; realJwtHttpRealtimeAudioTested = $false; concurrencyTested = $false
    evidence = $run
  }
  Write-TaskFile (Join-Path $run 'result.json') (($summary | ConvertTo-Json) + $nl)
  Get-Content -LiteralPath (Join-Path $run 'test.log') -Tail 10
  $summary | ConvertTo-Json
  if ($testError) { throw $testError }
  if (-not $ok) { throw 'Falló una comprobación de rollback, integridad o finalización; revisar result.json.' }
} finally {
  if ($started -or (Test-Path -LiteralPath (Join-Path $data 'postmaster.pid'))) {
    Invoke-LocalNative $ctl @('-D', $data, '-m', 'fast', '-w', '-t', '20', 'stop') (Join-Path $run 'stop.log')
    Write-Output 'PostgreSQL temporal detenido; evidencia conservada en TEMP.'
  }
}
