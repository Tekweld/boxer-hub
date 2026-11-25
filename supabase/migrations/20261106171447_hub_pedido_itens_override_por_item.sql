-- Grade granular por item pedida pelo Andre (2026-11-06), inspirada na
-- ferramenta antiga do representante: por produto, escolher uma tabela de
-- preco diferente (F1/F2/F3/H1/H2/H3/E1/E2/E3) e/ou aplicar um % de
-- desconto pontual, sem mudar o cadastro do cliente nem afetar os outros
-- itens do pedido.
--
-- desconto_item_percentual JA EXISTIA na tabela, sem nada lendo/escrevendo
-- nela ainda -- achado nesta investigacao, reaproveitado agora.
alter table comercial.hub_pedido_itens
  add column if not exists classe_override smallint,
  add column if not exists segmento_override text;

-- Mesma logica de hub_fn_calcular_preco, mas aceita segmento/classe
-- explicitos (UF continua sendo a real do cliente -- a grade nao expoe UF
-- por item, so segmento+classe) e aplica desconto pontual por cima.
create or replace function comercial.hub_fn_calcular_preco_item(
  p_cliente_id uuid,
  p_produto_id uuid,
  p_quantidade integer default 1,
  p_segmento_override text default null,
  p_classe_override smallint default null,
  p_desconto_pct numeric default null
)
returns jsonb
language plpgsql
stable security definer
set search_path to ''
as $function$
declare
  v_row record;
  v_promo record;
  v_uf text;
  v_preco numeric(12,2);
begin
  if not comercial.hub_pode_acessar_cliente(p_cliente_id) then
    return jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  end if;

  if p_segmento_override is not null and p_classe_override is not null then
    select c.uf into v_uf from comercial.hub_clientes c where c.id = p_cliente_id and c.ativo = true;
    if v_uf is null then
      return jsonb_build_object('ok', false, 'erro', 'Cliente sem UF cadastrada');
    end if;
    select produto_id, sku, preco_tabela, preco_final, multiplicador, porte, icms, ipi
      into v_row
      from comercial.hub_fn_precos_parametro(v_uf, p_segmento_override, p_classe_override)
     where produto_id = p_produto_id;
    if not found then
      return jsonb_build_object('ok', false, 'erro', 'Produto sem preco para a tabela escolhida');
    end if;
  else
    select * into v_row
      from comercial.hub_fn_precos_cliente(p_cliente_id, 0) f
     where f.produto_id = p_produto_id;
    if not found then
      return jsonb_build_object('ok', false, 'erro', 'Produto sem preco publicado para o estado/canal deste cliente');
    end if;
  end if;

  v_preco := v_row.preco_final;

  -- Campanha promocional ativa sobrepoe o preco da tabela -- mesma regra de
  -- hub_fn_calcular_preco, antes do desconto pontual por cima.
  select cp.preco_promocional, cp.desconto_percentual
    into v_promo
    from comercial.hub_campanha_produtos cp
    join comercial.hub_campanhas ca on ca.id = cp.campanha_id
   where cp.produto_id = p_produto_id
     and ca.ativo = true
     and current_date between ca.data_inicio and ca.data_fim
     and (cp.quantidade_limite is null or cp.quantidade_vendida < cp.quantidade_limite)
   order by ca.data_inicio desc
   limit 1;

  if found then
    if v_promo.preco_promocional is not null then
      v_preco := v_promo.preco_promocional;
    elsif v_promo.desconto_percentual is not null then
      v_preco := v_row.preco_final * (1 - v_promo.desconto_percentual / 100);
    end if;
  end if;

  if p_desconto_pct is not null and p_desconto_pct > 0 then
    v_preco := v_preco * (1 - p_desconto_pct / 100);
  end if;

  return jsonb_build_object(
    'ok', true,
    'preco_base', v_row.preco_tabela,
    'preco_final', round(v_preco, 2),
    'multiplicador', v_row.multiplicador,
    'ipi', v_row.ipi,
    'icms', v_row.icms,
    'em_promocao', found,
    'subtotal', round(v_preco * p_quantidade, 2)
  );
end
$function$;

-- hub_fn_submeter_pedido passa a respeitar override/desconto por item em
-- vez de sempre reprecificar pela politica padrao do cliente -- sem isto a
-- grade granular seria so cosmetica (qualquer ajuste feito na tela se
-- perderia na confirmacao, como ja acontecia com o preco manual do
-- carrinho ate hoje).
create or replace function comercial.hub_fn_submeter_pedido(p_pedido_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path to ''
as $function$
DECLARE
  v_pedido    record;
  v_cliente   record;
  v_item      record;
  v_preco     jsonb;
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

  -- (1) subtotal a preco de tabela -> define a faixa/classe (so importa pra
  -- quem nao tem override nenhum; com progressao_classe_ativa=0 isto nao
  -- muda mais a classe de ninguem, mas o calculo fica correto de qualquer
  -- jeito se a progressao for religada um dia).
  SELECT coalesce(sum(pi.quantidade * f.preco_tabela), 0)
    INTO v_subtotal_tabela
    FROM comercial.hub_pedido_itens pi
    JOIN comercial.hub_fn_precos_cliente(v_pedido.cliente_id, 0) f
      ON f.produto_id = pi.produto_id
   WHERE pi.pedido_id = p_pedido_id
     AND pi.classe_override IS NULL;

  -- (2) reprecificar cada item -- com override (tabela escolhida na grade)
  -- ou desconto pontual se houver, senao a politica padrao do cliente.
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

  -- (3) politica comercial (minimo, duplicata, parcelamento, frete)
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

  -- (4) credito: trava a linha do cliente e reserva
  SELECT * INTO v_cliente FROM comercial.hub_clientes
   WHERE id = v_pedido.cliente_id FOR UPDATE;

  IF v_cliente.status_cadastro != 'ativo' THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Cadastro nao esta ativo',
                              'status', v_cliente.status_cadastro);
  END IF;

  IF v_total > v_cliente.limite_disponivel THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Limite insuficiente',
      'limite_total', v_cliente.limite_credito,
      'disponivel',   v_cliente.limite_disponivel,
      'valor_pedido', v_total,
      'excedente',    v_total - v_cliente.limite_disponivel);
  END IF;

  v_numero := comercial.hub_fn_gerar_numero();

  UPDATE comercial.hub_clientes
     SET limite_disponivel = limite_disponivel - v_total,
         atualizado_em = now()
   WHERE id = v_pedido.cliente_id;

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
