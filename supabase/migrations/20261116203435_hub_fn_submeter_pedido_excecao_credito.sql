-- Item 1 (Credix) e item 6 (pedido feito por representante/funcionario
-- Boxer acima do limite): em vez de bloquear, o pedido entra em
-- status 'em_analise' (ja existia no check constraint, nunca usado) e
-- abre sozinho uma solicitacao (canal de resolucao ja existente) para
-- quem decide -- ADM de Vendas no caso do Credix (fintech avalia, mas quem
-- opera no Hub e o ADM de Vendas), Financeiro no caso de limite normal
-- excedido por rep/funcionario. Pedido feito pelo proprio cliente sem
-- Credix continua travando na hora (regra binaria original, Andre
-- 2026-09-01) -- excecao e so para quem o Andre pediu agora (2026-11-16).
CREATE OR REPLACE FUNCTION comercial.hub_fn_submeter_pedido(p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pedido    record;
  v_cliente   record;
  v_item      record;
  v_preco     jsonb;
  v_credito   jsonb;
  v_subtotal_tabela numeric(12,2) := 0;
  v_subtotal  numeric(12,2) := 0;
  v_itens     integer;
  v_numero    text;
  v_politica  jsonb;
  v_frete     numeric(12,2) := 0;
  v_total     numeric(12,2);
  v_excecao   boolean;
  v_sol_id    uuid;
BEGIN
  SELECT * INTO v_pedido FROM comercial.hub_pedidos
   WHERE id = p_pedido_id AND ativo = true;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  END IF;

  IF NOT comercial.hub_pode_acessar_cliente(v_pedido.cliente_id) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  END IF;

  IF v_pedido.status != 'rascunho' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido ja foi submetido');
  END IF;

  SELECT count(*) INTO v_itens
    FROM comercial.hub_pedido_itens WHERE pedido_id = p_pedido_id;
  IF v_itens = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido sem itens');
  END IF;

  SELECT coalesce(sum(pi.quantidade * f.preco_tabela), 0)
    INTO v_subtotal_tabela
    FROM comercial.hub_pedido_itens pi
    JOIN comercial.hub_fn_precos_cliente(v_pedido.cliente_id, 0) f
      ON f.produto_id = pi.produto_id
   WHERE pi.pedido_id = p_pedido_id
     AND pi.classe_override IS NULL;

  FOR v_item IN
    SELECT id, produto_id, quantidade, classe_override, segmento_override, desconto_item_percentual
      FROM comercial.hub_pedido_itens
     WHERE pedido_id = p_pedido_id
  LOOP
    IF v_item.classe_override IS NOT NULL OR v_item.desconto_item_percentual IS NOT NULL THEN
      v_preco := comercial.hub_fn_calcular_preco_item(
                   v_pedido.cliente_id, v_item.produto_id, v_item.quantidade,
                   v_item.segmento_override, v_item.classe_override, v_item.desconto_item_percentual);
    ELSE
      v_preco := comercial.hub_fn_calcular_preco(
                   v_pedido.cliente_id, v_item.produto_id,
                   v_item.quantidade, v_subtotal_tabela);
    END IF;

    IF (v_preco->>'ok')::boolean IS NOT TRUE THEN
      RETURN jsonb_build_object('ok', false,
        'erro', coalesce(v_preco->>'erro', 'Falha ao precificar item'));
    END IF;

    UPDATE comercial.hub_pedido_itens
       SET preco_unitario = (v_preco->>'preco_base')::numeric,
           preco_final    = (v_preco->>'preco_final')::numeric,
           subtotal_item  = (v_preco->>'subtotal')::numeric
     WHERE id = v_item.id;
  END LOOP;

  SELECT coalesce(sum(subtotal_item), 0) INTO v_subtotal
    FROM comercial.hub_pedido_itens WHERE pedido_id = p_pedido_id;

  UPDATE comercial.hub_pedidos SET subtotal = v_subtotal WHERE id = p_pedido_id;
  v_politica := comercial.hub_fn_validar_politica(p_pedido_id);

  IF (v_politica->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Pedido nao atende a politica comercial',
      'violacoes', coalesce(v_politica->'violacoes', '[]'::jsonb),
      'politica', v_politica);
  END IF;

  v_frete := coalesce((v_politica->'frete'->>'valor')::numeric, 0);
  v_total := v_subtotal - coalesce(v_pedido.desconto_valor, 0) + v_frete;

  SELECT * INTO v_cliente FROM comercial.hub_clientes
   WHERE id = v_pedido.cliente_id FOR UPDATE;

  IF v_cliente.status_cadastro != 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cadastro nao esta ativo',
                              'status', v_cliente.status_cadastro);
  END IF;

  IF v_cliente.grupo_erp_id IS NOT NULL THEN
    PERFORM 1 FROM comercial.hub_clientes
     WHERE grupo_erp_id = v_cliente.grupo_erp_id AND ativo = true
     FOR UPDATE;
  END IF;

  v_credito := comercial.hub_fn_validar_credito(v_pedido.cliente_id, v_total);

  IF (v_credito->>'ok')::boolean IS NOT TRUE THEN
    -- Excecao (Andre, 2026-11-16): Credix (qualquer origem) ou pedido feito
    -- por representante/funcionario Boxer (qualquer pagamento) nao bloqueia
    -- -- vira 'em_analise' e abre solicitacao pra quem decide. Cliente
    -- comum sem Credix continua bloqueado na hora (regra binaria original).
    v_excecao := v_pedido.forma_pagamento = 'credix' OR v_pedido.origem IN ('proxy_representante', 'admin');

    IF NOT v_excecao THEN
      RETURN jsonb_build_object('ok', false,
        'erro', coalesce(v_credito->>'erro', 'Limite insuficiente'),
        'limite_total', v_credito->'limite_total',
        'disponivel', v_credito->'disponivel',
        'valor_pedido', v_total,
        'excedente', v_credito->'excedente');
    END IF;

    v_numero := comercial.hub_fn_gerar_numero();

    UPDATE comercial.hub_pedidos SET
      numero        = v_numero,
      subtotal      = v_subtotal,
      valor_frete   = v_frete,
      valor_total   = v_total,
      status        = 'em_analise',
      atualizado_em = now()
    WHERE id = p_pedido_id;

    INSERT INTO comercial.hub_solicitacoes
      (cliente_id, representante_id, aberto_por_tipo, categoria, referencia_tipo, referencia_id, assunto)
    VALUES (
      v_pedido.cliente_id, v_pedido.representante_id,
      CASE WHEN v_pedido.origem = 'cliente' THEN 'cliente' ELSE 'representante' END,
      CASE WHEN v_pedido.forma_pagamento = 'credix' THEN 'outro' ELSE 'financeiro' END,
      'pedido', p_pedido_id,
      'Pedido ' || v_numero || ' acima do limite de credito'
    )
    RETURNING id INTO v_sol_id;

    INSERT INTO comercial.hub_solicitacao_mensagens (solicitacao_id, autor_tipo, autor_nome, mensagem)
    VALUES (
      v_sol_id,
      CASE WHEN v_pedido.origem = 'cliente' THEN 'cliente' ELSE 'funcionario' END,
      'Sistema',
      'Pedido ' || v_numero || ' no valor de ' || v_total::text ||
        ' excede o limite disponivel (' || coalesce(v_credito->>'disponivel', '0') || '). ' ||
        CASE WHEN v_pedido.forma_pagamento = 'credix'
          THEN 'Pagamento via Credix -- aguardando avaliacao do ADM de Vendas junto a fintech.'
          ELSE 'Pedido feito por representante/funcionario Boxer -- aguardando liberacao do financeiro.' END
    );

    RETURN jsonb_build_object(
      'ok', true,
      'numero', v_numero,
      'subtotal', v_subtotal,
      'valor_frete', v_frete,
      'valor_total', v_total,
      'itens', v_itens,
      'politica', v_politica,
      'pendente_credito', true,
      'solicitacao_id', v_sol_id
    );
  END IF;

  v_numero := comercial.hub_fn_gerar_numero();

  PERFORM comercial.hub_fn_ajustar_credito_grupo(v_pedido.cliente_id, -v_total);

  UPDATE comercial.hub_pedidos SET
    numero        = v_numero,
    subtotal      = v_subtotal,
    valor_frete   = v_frete,
    valor_total   = v_total,
    status        = 'submetido',
    atualizado_em = now()
  WHERE id = p_pedido_id;

  RETURN jsonb_build_object(
    'ok', true,
    'numero', v_numero,
    'subtotal', v_subtotal,
    'valor_frete', v_frete,
    'valor_total', v_total,
    'itens', v_itens,
    'politica', v_politica
  );
END
$function$;
