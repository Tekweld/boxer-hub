-- Fecha o ciclo da excecao criada em hub_fn_submeter_pedido: quem assumiu a
-- solicitacao (financeiro ou ADM de Vendas) aprova ou rejeita o pedido que
-- ficou em 'em_analise'. Aprovar reserva o credito so agora (nao na hora da
-- excecao, porque podia nao ser liberado) e reconsulta o grupo de novo --
-- outro pedido do mesmo cliente pode ter consumido credito nesse meio tempo.
CREATE OR REPLACE FUNCTION comercial.hub_fn_aprovar_pedido_em_analise(p_pedido_id uuid, p_solicitacao_id uuid default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pedido  record;
  v_cliente record;
  v_credito jsonb;
BEGIN
  SELECT * INTO v_pedido FROM comercial.hub_pedidos
   WHERE id = p_pedido_id AND ativo = true FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  END IF;

  IF v_pedido.status != 'em_analise' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao esta em analise (status atual: ' || v_pedido.status || ')');
  END IF;

  SELECT * INTO v_cliente FROM comercial.hub_clientes WHERE id = v_pedido.cliente_id FOR UPDATE;
  IF v_cliente.grupo_erp_id IS NOT NULL THEN
    PERFORM 1 FROM comercial.hub_clientes
     WHERE grupo_erp_id = v_cliente.grupo_erp_id AND ativo = true FOR UPDATE;
  END IF;

  v_credito := comercial.hub_fn_validar_credito(v_pedido.cliente_id, v_pedido.valor_total);
  IF (v_credito->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Credito ainda insuficiente para aprovar (' || coalesce(v_credito->>'erro','Limite insuficiente') || ')',
      'disponivel', v_credito->'disponivel', 'valor_pedido', v_pedido.valor_total);
  END IF;

  PERFORM comercial.hub_fn_ajustar_credito_grupo(v_pedido.cliente_id, -v_pedido.valor_total);

  UPDATE comercial.hub_pedidos SET status = 'submetido', atualizado_em = now() WHERE id = p_pedido_id;

  IF p_solicitacao_id IS NOT NULL THEN
    UPDATE comercial.hub_solicitacoes SET status = 'resolvida', resolvido_em = now() WHERE id = p_solicitacao_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'numero', v_pedido.numero, 'valor_total', v_pedido.valor_total);
END
$function$;

CREATE OR REPLACE FUNCTION comercial.hub_fn_rejeitar_pedido_em_analise(p_pedido_id uuid, p_solicitacao_id uuid default null)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pedido record;
BEGIN
  SELECT * INTO v_pedido FROM comercial.hub_pedidos
   WHERE id = p_pedido_id AND ativo = true FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  END IF;

  IF v_pedido.status != 'em_analise' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao esta em analise (status atual: ' || v_pedido.status || ')');
  END IF;

  -- Nenhum credito foi reservado quando entrou em 'em_analise' -- so marca
  -- rejeitado, nao ha nada a devolver (diferente de hub_fn_liberar_credito_rejeitado).
  UPDATE comercial.hub_pedidos SET status = 'rejeitado', atualizado_em = now() WHERE id = p_pedido_id;

  IF p_solicitacao_id IS NOT NULL THEN
    UPDATE comercial.hub_solicitacoes SET status = 'resolvida', resolvido_em = now() WHERE id = p_solicitacao_id;
  END IF;

  RETURN jsonb_build_object('ok', true, 'numero', v_pedido.numero);
END
$function$;
