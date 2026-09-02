-- Permite que um pedido submetido volte a ser rascunho, para o cliente
-- corrigir e reenviar.
--
-- Precisa ser funcao no banco (e nao um UPDATE no frontend) por um motivo
-- critico: hub_fn_submeter_pedido RESERVA credito ao submeter
-- (limite_disponivel = limite_disponivel - valor_total). Reverter sem devolver
-- essa reserva comeria o limite do cliente em silencio, a cada tentativa.
--
-- Fronteira de negocio (decidida com Andre em 2026-09-01): so da pra reverter
-- ENQUANTO o pedido nao foi pro Zen. Depois que virou venda la, quem manda no
-- pedido e o Zen/Monitor de Pedidos -- o Hub reverter dessincronizaria os dois
-- sistemas. Nesse caso o caminho e pedir cancelamento pelo canal de resolucao.

CREATE OR REPLACE FUNCTION comercial.hub_fn_reverter_pedido(p_pedido_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_pedido  record;
  v_cliente record;
  v_devolver numeric(12,2);
BEGIN
  SELECT * INTO v_pedido FROM comercial.hub_pedidos
   WHERE id = p_pedido_id AND ativo = true
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  END IF;

  IF NOT comercial.hub_pode_acessar_cliente(v_pedido.cliente_id) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  END IF;

  IF v_pedido.status <> 'submetido' THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'So pedido submetido pode voltar a rascunho',
      'status_atual', v_pedido.status);
  END IF;

  -- A trava que mantem Hub e Zen coerentes.
  IF v_pedido.erp_pedido_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false,
      'erro', 'Pedido ja foi enviado ao ERP e nao pode mais ser editado aqui',
      'erp_pedido_id', v_pedido.erp_pedido_id);
  END IF;

  -- Devolve a reserva de credito, sem estourar o limite total (defensivo:
  -- se o limite tiver sido reduzido no meio do caminho, nao inventa saldo).
  v_devolver := coalesce(v_pedido.valor_total, 0);

  SELECT * INTO v_cliente FROM comercial.hub_clientes
   WHERE id = v_pedido.cliente_id FOR UPDATE;

  UPDATE comercial.hub_clientes
     SET limite_disponivel = LEAST(
           coalesce(limite_disponivel, 0) + v_devolver,
           coalesce(limite_credito, 0)
         ),
         atualizado_em = now()
   WHERE id = v_pedido.cliente_id;

  -- Volta pro estado de rascunho. O numero sai junto: rascunho nao tem numero,
  -- e o reenvio gera um novo por hub_fn_gerar_numero(). Buraco na sequencia de
  -- numeracao e normal e preferivel a dois numeros para o mesmo pedido.
  UPDATE comercial.hub_pedidos SET
    status        = 'rascunho',
    numero        = NULL,
    atualizado_em = now()
  WHERE id = p_pedido_id;

  INSERT INTO comercial.hub_log_alteracoes
    (usuario_id, usuario_email, tabela_ref, registro_id, campo,
     valor_anterior, valor_novo, acao)
  VALUES
    (auth.uid(), auth.jwt() ->> 'email', 'hub_pedidos', p_pedido_id::text,
     'status', 'submetido', 'rascunho', 'reverter_pedido');

  RETURN jsonb_build_object(
    'ok', true,
    'numero_anterior', v_pedido.numero,
    'credito_devolvido', v_devolver
  );
END
$$;

GRANT EXECUTE ON FUNCTION comercial.hub_fn_reverter_pedido(uuid) TO authenticated;

COMMENT ON FUNCTION comercial.hub_fn_reverter_pedido(uuid) IS
  'Devolve um pedido submetido ao estado de rascunho, restaurando a reserva de credito. Bloqueado quando o pedido ja foi enviado ao Zen (erp_pedido_id preenchido).';
