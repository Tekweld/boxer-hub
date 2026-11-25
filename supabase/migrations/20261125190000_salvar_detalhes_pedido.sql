-- Representante nao tem policy de UPDATE em hub_pedidos (so cliente-rascunho e
-- analyst/manager/admin). O PATCH do confirmarEnvio (pedidos.html) afetava 0
-- linhas SEM erro, entao forma de pagamento, parcelas, dias, frete, OC e
-- observacoes nunca eram gravados nos pedidos de representante e o push ao Zen
-- levava "sem frete" + pagamento vazio (HUB-2026-05149 e HUB-2026-05747).
--
-- Em vez de abrir UPDATE amplo (o rep poderia mexer em valores), esta funcao
-- grava SOMENTE os campos de detalhe, apos checar quem esta chamando.
create or replace function comercial.hub_fn_salvar_detalhes_pedido(p_pedido_id uuid, p_dados jsonb)
returns jsonb
language plpgsql
security definer
set search_path = comercial, public
as $$
declare
  v_ped record;
  v_tipo text := comercial.hub_user_tipo();
  v_role text := comercial.hub_user_role();
  v_ok boolean := false;
  v_dias int[];
begin
  select id, cliente_id, status into v_ped from comercial.hub_pedidos where id = p_pedido_id;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'pedido_nao_encontrado');
  end if;
  if v_ped.status <> 'rascunho' then
    return jsonb_build_object('ok', false, 'erro', 'pedido_nao_e_rascunho');
  end if;
  if comercial.hub_user_cliente_bloqueado() then
    return jsonb_build_object('ok', false, 'erro', 'cliente_bloqueado');
  end if;

  if v_role in ('analyst', 'manager', 'admin') then
    v_ok := true;
  elsif v_tipo = 'cliente' and v_ped.cliente_id = comercial.hub_user_cliente_id() then
    v_ok := true;
  elsif v_tipo = 'representante' and exists (
    select 1 from comercial.hub_carteira c
    where c.cliente_id = v_ped.cliente_id
      and c.representante_id = comercial.hub_user_representante_id()
      and c.ativo = true
  ) then
    v_ok := true;
  end if;
  if not v_ok then
    return jsonb_build_object('ok', false, 'erro', 'sem_permissao');
  end if;

  if jsonb_typeof(p_dados -> 'dias_pagamento') = 'array' then
    select array_agg(x::int order by ord) into v_dias
    from jsonb_array_elements_text(p_dados -> 'dias_pagamento') with ordinality as t(x, ord);
  end if;

  update comercial.hub_pedidos set
    ordem_compra = case when p_dados ? 'ordem_compra' then nullif(trim(p_dados ->> 'ordem_compra'), '') else ordem_compra end,
    observacoes = case when p_dados ? 'observacoes' then nullif(trim(p_dados ->> 'observacoes'), '') else observacoes end,
    forma_pagamento = case when p_dados ? 'forma_pagamento' then p_dados ->> 'forma_pagamento' else forma_pagamento end,
    parcelas = case when p_dados ? 'parcelas' then (p_dados ->> 'parcelas')::smallint else parcelas end,
    dias_pagamento = case when p_dados ? 'dias_pagamento' then v_dias else dias_pagamento end,
    frete_modalidade = case when p_dados ? 'frete_modalidade' then p_dados ->> 'frete_modalidade' else frete_modalidade end,
    classe_comercial_aplicada = case when p_dados ? 'classe_comercial_aplicada' then (p_dados ->> 'classe_comercial_aplicada')::smallint else classe_comercial_aplicada end,
    segmento_aplicado = case when p_dados ? 'segmento_aplicado' then p_dados ->> 'segmento_aplicado' else segmento_aplicado end,
    uf_aplicada = case when p_dados ? 'uf_aplicada' then p_dados ->> 'uf_aplicada' else uf_aplicada end
  where id = p_pedido_id;

  return jsonb_build_object('ok', true);
end;
$$;

revoke all on function comercial.hub_fn_salvar_detalhes_pedido(uuid, jsonb) from public;
grant execute on function comercial.hub_fn_salvar_detalhes_pedido(uuid, jsonb) to authenticated;
