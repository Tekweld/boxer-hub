-- Achado pelo Andre, 2026-11-04: financeiro.html soma limite_credito de
-- todas as filiais do grupo empresarial -- mas quando o credito no ZEN e do
-- GRUPO (nao da pessoa), o sync (inicializarCreditoFaltante em
-- sync-zen-clientes.js) grava o MESMO valor do grupo em CADA filial membro
-- (ver comentario la: "Luitex, grupo 1139" -- creditLineStats por
-- PERSON_GROUP_IDS, replicado pra toda filial sem credito proprio). Somar
-- isso por filial multiplica o credito real por N. Esta coluna marca a
-- origem pra financeiro.html saber quando DEDUPLICAR (grupo = pega 1 vez)
-- em vez de somar (pessoa = soma de verdade, credito independente por CNPJ).
alter table comercial.hub_clientes
  add column if not exists limite_credito_fonte text check (limite_credito_fonte in ('grupo', 'pessoa'));

-- Backfill heuristico: dentro do mesmo grupo, limite_credito identico e
-- nao-zero em 2+ filiais so acontece pela replicacao de credito de grupo
-- (coincidencia de valor exato entre CNPJs juridicamente independentes e
-- praticamente impossivel) -- marca como 'grupo'. O resto que ja tem
-- limite_credito preenchido e credito real por pessoa.
with duplicado as (
  select grupo_erp_id, limite_credito
  from comercial.hub_clientes
  where grupo_erp_id is not null and limite_credito is not null and limite_credito > 0
  group by grupo_erp_id, limite_credito
  having count(*) > 1
)
update comercial.hub_clientes c
   set limite_credito_fonte = 'grupo'
  from duplicado d
 where c.grupo_erp_id = d.grupo_erp_id and c.limite_credito = d.limite_credito;

update comercial.hub_clientes
   set limite_credito_fonte = 'pessoa'
 where limite_credito_fonte is null and limite_credito is not null and limite_credito > 0;
