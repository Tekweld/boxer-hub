-- Pedidos que vieram do Zen (origem 'erp') apareciam sem linha do tempo e com a
-- data da IMPORTACAO (17-25/11/2026) em vez da data real da venda:
--  * 5188 de 5889 sem nenhum evento de etapa (4320 entregues sem nenhum)
--  * "Faturado" nunca virava evento, embora a nota fiscal ja esteja ligada ao pedido
--
-- erp_historico_em marca o pedido cujo historico de etapas + data real ja foram
-- trazidos do Zen (api/_historico_etapas.js, drenado em lotes pelo cron de 15 min).
alter table comercial.hub_pedidos
  add column if not exists erp_historico_em timestamptz;

create index if not exists idx_hub_pedidos_erp_historico_pendente
  on comercial.hub_pedidos (id)
  where origem = 'erp' and erp_historico_em is null and ativo;

-- "Faturado": a primeira nota fiscal do pedido vira evento na data de emissao.
-- Gatilho cobre notas novas/atualizadas; o INSERT abaixo cobre as ja existentes.
create or replace function comercial.hub_trg_evento_faturado()
returns trigger
language plpgsql
security definer
set search_path = comercial, public
as $$
begin
  if new.erp_pedido_id is null then
    return new;
  end if;

  insert into comercial.hub_pedido_eventos (pedido_id, etapa, origem, detalhe, criado_em)
  select p.id, 'Faturado', 'zen', 'NF ' || coalesce(new.numero_nf::text, '') ,
         coalesce(new.data_emissao::timestamptz, now())
  from comercial.hub_pedidos p
  where p.erp_pedido_id::text = new.erp_pedido_id::text
  on conflict (pedido_id, etapa) do nothing;

  -- pedido ainda "aprovado/em separacao" passa a "faturado" (so para nota nova;
  -- o historico NAO muda status em massa para nao disparar notificacoes).
  update comercial.hub_pedidos
     set status = 'faturado', atualizado_em = now()
   where erp_pedido_id::text = new.erp_pedido_id::text
     and status in ('aprovado', 'em_separacao')
     and ativo;

  return new;
end;
$$;

drop trigger if exists trg_hub_evento_faturado on comercial.hub_notas_fiscais;
create trigger trg_hub_evento_faturado
  after insert or update of erp_pedido_id on comercial.hub_notas_fiscais
  for each row execute function comercial.hub_trg_evento_faturado();

-- Notas ja existentes: um evento "Faturado" por pedido (a NF mais antiga).
insert into comercial.hub_pedido_eventos (pedido_id, etapa, origem, detalhe, criado_em)
select distinct on (p.id) p.id, 'Faturado', 'zen', 'NF ' || coalesce(nf.numero_nf::text, ''),
       coalesce(nf.data_emissao::timestamptz, now())
from comercial.hub_notas_fiscais nf
join comercial.hub_pedidos p on p.erp_pedido_id::text = nf.erp_pedido_id::text
where nf.erp_pedido_id is not null and nf.ativo
order by p.id, nf.data_emissao asc nulls last
on conflict (pedido_id, etapa) do nothing;
