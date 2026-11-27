-- Sync de clientes (2026-11-27): a etapa "inicializar limite de credito" consultava o ZEN cliente por cliente para TODOS os
-- ~6.700 sem limite a cada rodada e estourava os 300 s da function (workflow sempre em falha). Passa a processar em fatias,
-- reconsultando cada cliente so depois de 2 dias; esta coluna guarda quando o credito foi verificado pela ultima vez.
alter table comercial.hub_clientes add column if not exists credito_verificado_em timestamptz;
comment on column comercial.hub_clientes.credito_verificado_em is 'Ultima consulta do credito no ZEN pelo sync de clientes (api/sync-zen-clientes.js).';
