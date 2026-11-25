-- Helper unico: aplica um delta (negativo=reserva, positivo=liberacao) no
-- credito disponivel de um cliente, respeitando grupo empresarial (mesma
-- logica de hub_fn_validar_credito). Usado por hub_fn_submeter_pedido e
-- hub_fn_liberar_credito_rejeitado, que ate 2026-11-16 duplicavam a conta
-- direto na filial do pedido -- em grupos com credito concentrado numa
-- filial "sede" (Diafer, Dutra), isso reservava/devolvia na linha errada
-- (a da filial que submeteu, quase sempre com limite_disponivel=0).
CREATE OR REPLACE FUNCTION comercial.hub_fn_ajustar_credito_grupo(p_cliente_id uuid, p_delta numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_grupo_erp_id integer;
BEGIN
  SELECT grupo_erp_id INTO v_grupo_erp_id FROM comercial.hub_clientes WHERE id = p_cliente_id;

  IF v_grupo_erp_id IS NULL THEN
    UPDATE comercial.hub_clientes
       SET limite_disponivel = LEAST(GREATEST(COALESCE(limite_disponivel,0) + p_delta, 0), COALESCE(limite_credito,0)),
           atualizado_em = now()
     WHERE id = p_cliente_id;
    RETURN;
  END IF;

  -- Fonte 'grupo': valor replicado identico em cada filial -- aplica o mesmo
  -- delta em cada copia, pra continuarem iguais entre si.
  UPDATE comercial.hub_clientes
     SET limite_disponivel = LEAST(GREATEST(COALESCE(limite_disponivel,0) + p_delta, 0), COALESCE(limite_credito,0)),
         atualizado_em = now()
   WHERE grupo_erp_id = v_grupo_erp_id AND ativo = true AND limite_credito_fonte = 'grupo';

  -- Fonte 'pessoa' (ou sem fonte definida): credito de verdade e proprio de
  -- cada filial, soma de verdade -- distribui o delta greedy. Reserva
  -- (delta<0) comeca pela filial com mais disponivel; liberacao (delta>0)
  -- comeca pela que tem mais espaco livre ate o proprio limite.
  IF p_delta < 0 THEN
    WITH alvo AS (
      SELECT id, limite_disponivel,
             GREATEST(0, LEAST(limite_disponivel,
               (-p_delta) - COALESCE(SUM(limite_disponivel) OVER (ORDER BY limite_disponivel DESC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS valor
        FROM comercial.hub_clientes
       WHERE grupo_erp_id = v_grupo_erp_id AND ativo = true
         AND (limite_credito_fonte IS DISTINCT FROM 'grupo')
    )
    UPDATE comercial.hub_clientes c
       SET limite_disponivel = c.limite_disponivel - alvo.valor, atualizado_em = now()
      FROM alvo WHERE c.id = alvo.id AND alvo.valor > 0;
  ELSE
    WITH espaco AS (
      SELECT id, GREATEST(COALESCE(limite_credito,0) - COALESCE(limite_disponivel,0), 0) AS vago
        FROM comercial.hub_clientes
       WHERE grupo_erp_id = v_grupo_erp_id AND ativo = true
         AND (limite_credito_fonte IS DISTINCT FROM 'grupo')
    ),
    alvo AS (
      SELECT id,
             GREATEST(0, LEAST(vago,
               p_delta - COALESCE(SUM(vago) OVER (ORDER BY vago DESC
                 ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0))) AS valor
        FROM espaco
    )
    UPDATE comercial.hub_clientes c
       SET limite_disponivel = c.limite_disponivel + alvo.valor, atualizado_em = now()
      FROM alvo WHERE c.id = alvo.id AND alvo.valor > 0;
  END IF;
END;
$function$;

-- hub_fn_submeter_pedido: troca a checagem/reserva direta na filial pelo
-- helper acima (via hub_fn_validar_credito, ja corrigida para grupo).
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

  -- Trava tambem as demais filiais do grupo (se houver) antes de checar --
  -- sem isso, dois pedidos simultaneos de filiais irmas poderiam passar a
  -- validacao os dois, reservando mais do que o grupo realmente tem.
  IF v_cliente.grupo_erp_id IS NOT NULL THEN
    PERFORM 1 FROM comercial.hub_clientes
     WHERE grupo_erp_id = v_cliente.grupo_erp_id AND ativo = true
     FOR UPDATE;
  END IF;

  v_credito := comercial.hub_fn_validar_credito(v_pedido.cliente_id, v_total);
  IF (v_credito->>'ok')::boolean IS NOT TRUE THEN
    RETURN jsonb_build_object('ok', false,
      'erro', coalesce(v_credito->>'erro', 'Limite insuficiente'),
      'limite_total', v_credito->'limite_total',
      'disponivel', v_credito->'disponivel',
      'valor_pedido', v_total,
      'excedente', v_credito->'excedente');
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

-- hub_fn_liberar_credito_rejeitado: devolve pelo mesmo helper, em vez de
-- somar direto na filial do pedido.
CREATE OR REPLACE FUNCTION comercial.hub_fn_liberar_credito_rejeitado(p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pedido record;
  v_devolver numeric(12,2);
begin
  select * into v_pedido from comercial.hub_pedidos
   where id = p_pedido_id and ativo = true
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  end if;

  if v_pedido.status = 'rejeitado' then
    return jsonb_build_object('ok', true, 'ja_liberado', true);
  end if;

  v_devolver := coalesce(v_pedido.valor_total, 0);

  perform comercial.hub_fn_ajustar_credito_grupo(v_pedido.cliente_id, v_devolver);

  update comercial.hub_pedidos set
    status        = 'rejeitado',
    atualizado_em = now()
  where id = p_pedido_id;

  insert into comercial.hub_log_alteracoes
    (usuario_id, usuario_email, tabela_ref, registro_id, campo,
     valor_anterior, valor_novo, acao)
  values
    (null, 'sync-pedidos-zen', 'hub_pedidos', p_pedido_id::text,
     'status', v_pedido.status, 'rejeitado', 'liberar_credito_rejeitado');

  return jsonb_build_object('ok', true, 'credito_devolvido', v_devolver);
end
$function$;
