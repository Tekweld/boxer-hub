
-- Estado persistente de sincronizacoes historicas (cursor + "ja concluiu?"),
-- pra sobreviver entre disparos do GitHub Actions sem precisar ler log.
-- Generico (chave/valor), nao so pra NF -- qualquer backfill historico
-- futuro pode reaproveitar.
create table if not exists comercial.hub_sync_estado (
  chave text primary key,
  valor jsonb not null default '{}'::jsonb,
  atualizado_em timestamptz not null default now()
);
alter table comercial.hub_sync_estado enable row level security;
create policy hub_sync_estado_select_admin on comercial.hub_sync_estado
  for select using (comercial.hub_user_role() = 'admin');
