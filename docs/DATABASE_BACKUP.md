# PostgreSQL backup and restore drill

The archive contains the owner account, library metadata, collections, playlists,
history, storage references and migration history. It excludes session and
sign-in throttle records. The dump contains private data, including the owner
password hash. Keep it in a restricted, encrypted directory outside the
repository. Keep the encryption recovery material separately.

This procedure covers PostgreSQL. Full library recovery also requires a matching
copy of the media objects and the server configuration, including storage
credentials or a way to recover them. Drive registry rows identify file revisions,
while the corresponding media bytes live in Drive. Preserve both before relying
on a backup for recovery.

## Make and check an archive

From the checkout with the local Compose database running, use PowerShell 7.4 or
newer so redirection preserves binary data. Replace the example destination with
an existing private directory on encrypted storage.

```powershell
$backupRoot = (Resolve-Path 'X:\privateflix-backups').Path
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$backup = Join-Path $backupRoot "privateflix-db-$stamp.dump"
$partial = "$backup.partial"
if ((Test-Path -LiteralPath $backup) -or (Test-Path -LiteralPath $partial)) {
  throw 'Choose a new backup filename.'
}

docker compose exec -T postgres pg_dump --username=privateflix --dbname=privateflix --format=custom --lock-wait-timeout=10s --exclude-table-data=public.sessions --exclude-table-data=public.auth_throttles > $partial
if ($LASTEXITCODE -ne 0) { throw 'Database backup failed.' }
$digest = (Get-FileHash -Algorithm SHA256 -LiteralPath $partial).Hash
Set-Content -LiteralPath "$backup.sha256" -Value $digest -Encoding ascii
Move-Item -LiteralPath $partial -Destination $backup
```

Keep the archive and its checksum together. A `.partial` file indicates an
unfinished run. On Linux use the same `pg_dump` options with binary-safe shell
redirection and private file permissions, then record the checksum with
`sha256sum`. [PostgreSQL 16 pg_dump reference](https://www.postgresql.org/docs/16/app-pgdump.html)

## Restore into an isolated database

Use a disposable PostgreSQL 16 container named `privateflix-restore-drill` with
the `privateflix` database role and no published ports. Keep PrivateFlix and its
worker disconnected from the drill. Restore only archives produced by a trusted
server. A successful restore is a stronger verification than listing the archive
contents. [PostgreSQL 16 pg_restore reference](https://www.postgresql.org/docs/16/app-pgrestore.html)

Create a private Docker environment file for the drill with
`POSTGRES_USER=privateflix`, `POSTGRES_DB=postgres` and a new throwaway
`POSTGRES_PASSWORD`. Set `$drillEnv` to that file's absolute path. This reuses the
local Compose PostgreSQL image. Wait for `pg_isready` to report that PostgreSQL
accepts connections before running the restore commands.

```powershell
$drill = 'privateflix-restore-drill'
$pgImage = docker compose images -q postgres
if ($LASTEXITCODE -ne 0 -or -not $pgImage) { throw 'Local PostgreSQL image not found.' }
docker run --rm -d --network none --name $drill --env-file $drillEnv $pgImage
if ($LASTEXITCODE -ne 0) { throw 'Could not start a new restore container.' }
docker exec $drill pg_isready -h 127.0.0.1 --username=privateflix --dbname=postgres
```

```powershell
$expected = (Get-Content -Raw -LiteralPath "$backup.sha256").Trim()
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $backup).Hash -ne $expected) {
  throw 'Backup checksum mismatch.'
}

$drill = 'privateflix-restore-drill'
docker cp $backup "${drill}:/tmp/privateflix-db.dump"
if ($LASTEXITCODE -ne 0) { throw 'Copy to restore container failed.' }
docker exec $drill pg_restore --list /tmp/privateflix-db.dump
if ($LASTEXITCODE -ne 0) { throw 'Archive could not be read.' }
docker exec $drill createdb --username=privateflix --template=template0 privateflix_restore_test
if ($LASTEXITCODE -ne 0) { throw 'Use a fresh restore database.' }
docker exec $drill pg_restore --username=privateflix --dbname=privateflix_restore_test --single-transaction --no-owner --no-privileges /tmp/privateflix-db.dump
if ($LASTEXITCODE -ne 0) { throw 'Database restore failed.' }

$checks = 'SELECT count(*) FROM users; SELECT count(*) FROM media; SELECT count(*) FROM _prisma_migrations; SELECT count(*) FROM sessions; SELECT count(*) FROM auth_throttles;'
docker exec $drill psql --username=privateflix --dbname=privateflix_restore_test --no-psqlrc --set=ON_ERROR_STOP=1 --command $checks
if ($LASTEXITCODE -ne 0) { throw 'Restored database checks failed.' }
```

Compare owner, media and migration counts with the expected snapshot. Session and
throttle counts should be zero. Run `docker stop $drill` to remove the temporary
container and its anonymous volume after the drill. Remove the throwaway
environment file as well. This procedure was verified on a synthetic
PostgreSQL 16 database with one owner, three media rows and six migrations. Media
checksums matched after restoration, and the seeded session and throttle records
were excluded.
