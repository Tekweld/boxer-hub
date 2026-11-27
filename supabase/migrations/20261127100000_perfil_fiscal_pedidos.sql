-- Perfil fiscal da operacao (sale.Sale.fiscalProfileOperation no ZEN): distingue venda, bonificacao (saida de brinde),
-- devolucao e outras operacoes. E tambem fixa a data do ZEN (sale.date) nos pedidos importados do ERP.
alter table comercial.hub_pedidos
  add column if not exists erp_perfil_fiscal_id int,
  add column if not exists erp_perfil_fiscal text,
  add column if not exists tipo_operacao text not null default 'venda';

alter table comercial.hub_pedidos drop constraint if exists hub_pedidos_tipo_operacao_check;
alter table comercial.hub_pedidos
  add constraint hub_pedidos_tipo_operacao_check check (tipo_operacao in ('venda', 'bonificacao', 'devolucao', 'outra'));

comment on column comercial.hub_pedidos.erp_perfil_fiscal is 'Descricao do perfil fiscal da operacao no ZEN (ex.: Saida de brinde).';
comment on column comercial.hub_pedidos.tipo_operacao is 'venda | bonificacao | devolucao | outra -- derivado de erp_perfil_fiscal (api/_perfil_fiscal.js).';

-- Aplica em lote o perfil fiscal (e a data do ZEN) lidos de sale.Sale. Chamada so pelo service_role.
create or replace function comercial.hub_fn_pedidos_perfil_fiscal(p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = comercial, public
as $$
declare v_atualizados int := 0; v_datas int := 0;
begin
  -- quantos pedidos do ERP tem o dia diferente do ZEN (sera corrigido pelo update abaixo)
  select count(*) into v_datas
    from comercial.hub_pedidos p
    join (select (x ->> 'erp_pedido_id') as erp_id, nullif(x ->> 'data', '')::timestamptz as data_zen from jsonb_array_elements(p_dados) x) d
      on p.erp_pedido_id::text = d.erp_id
   where p.origem = 'erp' and d.data_zen is not null
     and (p.criado_em at time zone 'America/Sao_Paulo')::date <> (d.data_zen at time zone 'America/Sao_Paulo')::date;

  with d as (
    select (x ->> 'erp_pedido_id') as erp_id, nullif(x ->> 'perfil_id', '')::int as perfil_id,
           x ->> 'perfil' as perfil, x ->> 'tipo' as tipo, nullif(x ->> 'data', '')::timestamptz as data_zen
    from jsonb_array_elements(p_dados) x
  ), up as (
    update comercial.hub_pedidos p
       set erp_perfil_fiscal_id = d.perfil_id, erp_perfil_fiscal = d.perfil, tipo_operacao = d.tipo,
           criado_em = case when p.origem = 'erp' and d.data_zen is not null
                             and (p.criado_em at time zone 'America/Sao_Paulo')::date <> (d.data_zen at time zone 'America/Sao_Paulo')::date
                            then d.data_zen else p.criado_em end
      from d
     where p.erp_pedido_id::text = d.erp_id
       and (p.erp_perfil_fiscal_id is distinct from d.perfil_id or p.tipo_operacao is distinct from d.tipo
            or (p.origem = 'erp' and d.data_zen is not null
                and (p.criado_em at time zone 'America/Sao_Paulo')::date <> (d.data_zen at time zone 'America/Sao_Paulo')::date))
    returning 1
  )
  select count(*) into v_atualizados from up;
  return jsonb_build_object('atualizados', v_atualizados, 'datas_corrigidas', v_datas);
end;
$$;
revoke all on function comercial.hub_fn_pedidos_perfil_fiscal(jsonb) from public, anon, authenticated;
grant execute on function comercial.hub_fn_pedidos_perfil_fiscal(jsonb) to service_role;
