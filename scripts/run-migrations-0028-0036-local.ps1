param(
  [Parameter(Mandatory = $true)][string]$PgBin,
  [ValidateRange(49152, 65535)][int]$Port = 54438
)
# Ensayo local sin servicios globales. Requiere binarios PostgreSQL ya descargados en TEMP.
# Crea un cluster nuevo por ejecución; conserva logs y apaga solo ese cluster en finally.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$taskTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$PgBin = (Resolve-Path -LiteralPath $PgBin).Path
if (-not $PgBin.StartsWith($taskTemp, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Usar binarios portátiles dentro de TEMP, no una instalación del sistema.'
}
foreach ($name in @('initdb', 'pg_ctl', 'psql', 'pg_dump')) {
  if (-not (Test-Path -LiteralPath (Join-Path $PgBin ($name + '.exe')))) { throw "Falta $name.exe" }
}
$node = (Get-Command node -ErrorAction Stop).Source
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
try { $listener.Start() } finally { $listener.Stop() }
$run = Join-Path $taskTemp ('venus-sql-run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Path $run | Out-Null
Write-Output "Evidencia local: $run"
$utf8 = [Text.UTF8Encoding]::new($false)
$nl = [Environment]::NewLine
function Write-TaskFile([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, ($Text -replace '\r?\n', $nl), $utf8)
}
function Invoke-LocalNative([string]$Exe, [string[]]$Arguments, [string]$Log) {
  & $Exe @Arguments *> $Log
  if ($LASTEXITCODE -ne 0) {
    Get-Content -LiteralPath $Log -Tail 35 | Write-Output
    throw "Error $LASTEXITCODE en $Exe; evidencia: $Log"
  }
}
$baseline = @(Get-ChildItem -LiteralPath (Join-Path $repo 'supabase\migrations') -File |
  Where-Object Name -Match '^00(?:0[1-9]|1[0-9]|2[0-7])_.*\.sql$' | Sort-Object Name)
if ($baseline.Count -ne 27) { throw 'Se requieren las 27 migraciones base.' }
$tracked = @($baseline.FullName) + @(
  Get-ChildItem -LiteralPath (Join-Path $repo 'supabase\migrations') -File |
  Where-Object Name -Match '^00(?:2[89]|3[0-6])_.*\.sql$' | Sort-Object Name | ForEach-Object FullName
) + @(
  (Join-Path $repo 'supabase\tests\fixtures\managed-schemas-minimal.sql'),
  (Join-Path $repo 'supabase\tests\migrations-0028-0036-rollback.sql'),
  (Join-Path $repo 'scripts\build-migrations-0028-0036-query.js')
)
$beforeHashes = @($tracked | ForEach-Object { Get-FileHash -LiteralPath $_ -Algorithm SHA256 })
$beforeHashes | Select-Object Path, Hash | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run 'inputs.json') -Encoding utf8
$baseSql = 'BEGIN;' + $nl + (($baseline | ForEach-Object {
  '-- ' + $_.Name + $nl + [IO.File]::ReadAllText($_.FullName)
}) -join $nl) + $nl + 'COMMIT;' + $nl
Write-TaskFile (Join-Path $run 'baseline.sql') $baseSql
Invoke-LocalNative $node @((Join-Path $repo 'scripts\build-migrations-0028-0036-query.js'), '--mode', 'all', '--output', (Join-Path $run 'harness.sql')) (Join-Path $run 'build-query.log')

# Huellas de todas las filas locales y estados de secuencias: solo hashes/cantidades, no contenido.
$stateSql = @'
SET statement_timeout = '30s';
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
  # Redirigir pg_ctl con una tubería PowerShell deja handles heredados en el servidor.
  # Esperar solo el proceso iniciador, no todo el árbol que incluye PostgreSQL.
  $startArgs = '-D "' + $data + '" -l "' + (Join-Path $run 'postgres.log') + '" -w -t 20 start'
  $starter = Start-Process -FilePath $ctl -ArgumentList $startArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $run 'start.log') -RedirectStandardError (Join-Path $run 'start-error.log')
  if (-not $starter.WaitForExit(30000)) { throw 'pg_ctl no terminó en 30 segundos.' }
  if ($starter.ExitCode -ne 0) { throw 'pg_ctl no pudo iniciar el cluster temporal; revisar start-error.log.' }
  $started = $true
  Invoke-LocalNative $psql @('-X', '-w', '-h', '127.0.0.1', '-p', "$Port", '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE venus_sql_test') (Join-Path $run 'create.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $repo 'supabase\tests\fixtures\managed-schemas-minimal.sql'))) (Join-Path $run 'fixtures.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'baseline.sql'))) (Join-Path $run 'baseline.log')
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-before.sql'))) (Join-Path $run 'dump-before.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'state.sql'))) (Join-Path $run 'state-before.json')
  Invoke-LocalNative $psql ($connection + @('-X', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'harness.sql'))) (Join-Path $run 'harness.log')
  Invoke-LocalNative $dump ($connection + @('--schema-only', '--file', (Join-Path $run 'schema-after.sql'))) (Join-Path $run 'dump-after.log')
  Invoke-LocalNative $psql ($connection + @('-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-f', (Join-Path $run 'state.sql'))) (Join-Path $run 'state-after.json')
  $schemaBefore = [IO.File]::ReadAllText((Join-Path $run 'schema-before.sql')) -replace '(?m)^\\(?:un)?restrict .*\r?\n', ''
  $schemaAfter = [IO.File]::ReadAllText((Join-Path $run 'schema-after.sql')) -replace '(?m)^\\(?:un)?restrict .*\r?\n', ''
  if ($schemaBefore -cne $schemaAfter) { throw 'El esquema/ACL después del rollback difiere.' }
  if ([IO.File]::ReadAllText((Join-Path $run 'state-before.json')) -cne [IO.File]::ReadAllText((Join-Path $run 'state-after.json'))) {
    throw 'Las filas o secuencias difieren después del rollback.'
  }
  foreach ($inputFile in $beforeHashes) {
    if ((Get-FileHash -LiteralPath $inputFile.Path -Algorithm SHA256).Hash -ne $inputFile.Hash) {
      throw "El archivo cambió durante el ensayo: $($inputFile.Path)"
    }
  }
  $summary = [ordered]@{
    ok = $true; environment = 'PostgreSQL local; fixtures parciales de Supabase'
    baselineMigrations = 27; rollbackMigrations = 9
    schemaAndAclRestored = $true; rowsAndSequencesRestored = $true; inputsUnchanged = $true
    realAuthStorageRealtimePushTested = $false; pgNetInstalled = $false
    evidence = $run
  }
  Write-TaskFile (Join-Path $run 'result.json') (($summary | ConvertTo-Json) + $nl)
  Get-Content -LiteralPath (Join-Path $run 'harness.log') -Tail 70
  $summary | ConvertTo-Json
} finally {
  if ($started -or (Test-Path -LiteralPath (Join-Path $data 'postmaster.pid'))) {
    Invoke-LocalNative $ctl @('-D', $data, '-m', 'fast', '-w', '-t', '20', 'stop') (Join-Path $run 'stop.log')
    Write-Output 'PostgreSQL temporal detenido; logs y fixtures conservados en TEMP.'
  }
}
