CREATE OR REPLACE FUNCTION comercial.hub_fn_validar_credito(p_cliente_id uuid, p_valor numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_grupo_erp_id integer;
  v_status text;
  v_limite numeric;
  v_disponivel numeric;
begin
  if not comercial.hub_pode_acessar_cliente(p_cliente_id) then
    return jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  end if;

  select grupo_erp_id, status_cadastro
  into v_grupo_erp_id, v_status
  from comercial.hub_clientes
  where id = p_cliente_id and ativo = true;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Cliente nao encontrado');
  end if;

  if v_status != 'ativo' then
    return jsonb_build_object('ok', false, 'erro', 'Cadastro nao esta ativo', 'status', v_status);
  end if;

  -- Credito por grupo empresarial (Andre, 2026-11-03/04): no ZEN o credito pode
  -- estar na PESSOA (cada filial com valor proprio, soma de verdade) ou no GRUPO
  -- (uma linha so, replicada em todas as filiais -- contar todas duplicaria).
  -- limite_credito_fonte ('pessoa'/'grupo', gravado por sync-zen-clientes.js)
  -- resolve: soma as de fonte 'pessoa', conta as de fonte 'grupo' so uma vez.
  -- Mesma logica de comercial.somarCreditoGrupo (hub.js), agora tambem aqui --
  -- ate 2026-11-16 esta funcao olhava so a filial do p_cliente_id, e grupos
  -- como Diafer/Dutra (credito concentrado numa filial "sede") apareciam
  -- zerados em qualquer outra filial.
  if v_grupo_erp_id is not null then
    select
      coalesce(sum(limite_credito) filter (where limite_credito_fonte is distinct from 'grupo'), 0)
        + coalesce(max(limite_credito) filter (where limite_credito_fonte = 'grupo'), 0),
      coalesce(sum(limite_disponivel) filter (where limite_credito_fonte is distinct from 'grupo'), 0)
        + coalesce(max(limite_disponivel) filter (where limite_credito_fonte = 'grupo'), 0)
    into v_limite, v_disponivel
    from comercial.hub_clientes
    where grupo_erp_id = v_grupo_erp_id and ativo = true;
  else
    select limite_credito, limite_disponivel into v_limite, v_disponivel
    from comercial.hub_clientes where id = p_cliente_id;
  end if;

  if p_valor > v_disponivel then
    return jsonb_build_object(
      'ok', false,
      'erro', 'Limite insuficiente',
      'limite_total', v_limite,
      'disponivel', v_disponivel,
      'valor_pedido', p_valor,
      'excedente', p_valor - v_disponivel
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'limite_total', v_limite,
    'disponivel', v_disponivel,
    'disponivel_apos', v_disponivel - p_valor
  );
end;
$function$;
