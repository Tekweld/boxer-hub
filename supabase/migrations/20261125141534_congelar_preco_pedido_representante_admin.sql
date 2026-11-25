-- Pedido do Andre, 2026-11-25: preco mostrado na revisao de um pedido feito
-- por representante/admin (em nome da revenda, ja alinhado com o cliente
-- antes de submeter) tem que ser EXATAMENTE o que vai pro ZEN -- sem
-- repreficacao escondida no submeter. So a propria revenda confirmando por
-- conta propria (origem='cliente', sem edicao manual possivel) deve
-- continuar sendo repreficada ao vivo pela politica vigente (ela nao edita
-- nada, entao repreficar e so reaplicar a mesma formula deterministica).
-- Achado real: pedido HUB-2026-05149 (origem proxy_representante) saiu com
-- valor diferente do que a Cristina via na tela.
create or replace function comercial.hub_fn_submeter_pedido(p_pedido_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
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
begin
  select * into v_pedido from comercial.hub_pedidos
   where id = p_pedido_id and ativo = true;

  if not found then
    return jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  end if;

  if not comercial.hub_pode_acessar_cliente(v_pedido.cliente_id) then
    return jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  end if;

  if v_pedido.status != 'rascunho' then
    return jsonb_build_object('ok', false, 'erro', 'Pedido ja foi submetido');
  end if;

  select count(*) into v_itens
    from comercial.hub_pedido_itens where pedido_id = p_pedido_id;
  if v_itens = 0 then
    return jsonb_build_object('ok', false, 'erro', 'Pedido sem itens');
  end if;

  -- Repreficacao ao vivo SO pra revenda confirmando por conta propria
  -- (origem='cliente'): sem edicao manual possivel do lado dela, entao
  -- reaplicar a politica agora e so reconfirmar a mesma formula
  -- deterministica. Pedido feito por representante/admin ja foi alinhado
  -- com o cliente antes -- usa o preco que ja esta gravado em
  -- hub_pedido_itens (o que a revisao mostrou), nunca recalcula escondido.
  if v_pedido.origem = 'cliente' then
    select coalesce(sum(pi.quantidade * f.preco_tabela), 0)
      into v_subtotal_tabela
      from comercial.hub_pedido_itens pi
      join comercial.hub_fn_precos_cliente(v_pedido.cliente_id, 0) f
        on f.produto_id = pi.produto_id
     where pi.pedido_id = p_pedido_id
       and pi.classe_override is null;

    for v_item in
      select id, produto_id, quantidade, classe_override, segmento_override, desconto_item_percentual
        from comercial.hub_pedido_itens
       where pedido_id = p_pedido_id
    loop
      if v_item.classe_override is not null or v_item.desconto_item_percentual is not null then
        v_preco := comercial.hub_fn_calcular_preco_item(
                     v_pedido.cliente_id, v_item.produto_id, v_item.quantidade,
                     v_item.segmento_override, v_item.classe_override, v_item.desconto_item_percentual);
      else
        v_preco := comercial.hub_fn_calcular_preco(
                     v_pedido.cliente_id, v_item.produto_id,
                     v_item.quantidade, v_subtotal_tabela);
      end if;

      if (v_preco->>'ok')::boolean is not true then
        return jsonb_build_object('ok', false,
          'erro', coalesce(v_preco->>'erro', 'Falha ao precificar item'));
      end if;

      update comercial.hub_pedido_itens
         set preco_unitario = (v_preco->>'preco_base')::numeric,
             preco_final    = (v_preco->>'preco_final')::numeric,
             subtotal_item  = (v_preco->>'subtotal')::numeric
       where id = v_item.id;
    end loop;
  end if;

  select coalesce(sum(subtotal_item), 0) into v_subtotal
    from comercial.hub_pedido_itens where pedido_id = p_pedido_id;

  update comercial.hub_pedidos set subtotal = v_subtotal where id = p_pedido_id;
  v_politica := comercial.hub_fn_validar_politica(p_pedido_id);

  if (v_politica->>'ok')::boolean is not true then
    return jsonb_build_object('ok', false,
      'erro', 'Pedido nao atende a politica comercial',
      'violacoes', coalesce(v_politica->'violacoes', '[]'::jsonb),
      'politica', v_politica);
  end if;

  v_frete := coalesce((v_politica->'frete'->>'valor')::numeric, 0);
  v_total := v_subtotal - coalesce(v_pedido.desconto_valor, 0) + v_frete;

  select * into v_cliente from comercial.hub_clientes
   where id = v_pedido.cliente_id for update;

  if v_cliente.status_cadastro != 'ativo' then
    return jsonb_build_object('ok', false, 'erro', 'Cadastro nao esta ativo',
                              'status', v_cliente.status_cadastro);
  end if;

  if v_cliente.grupo_erp_id is not null then
    perform 1 from comercial.hub_clientes
     where grupo_erp_id = v_cliente.grupo_erp_id and ativo = true
     for update;
  end if;

  v_credito := comercial.hub_fn_validar_credito(v_pedido.cliente_id, v_total);

  if (v_credito->>'ok')::boolean is not true then
    v_excecao := v_pedido.forma_pagamento = 'credix' or v_pedido.origem in ('proxy_representante', 'admin');

    if not v_excecao then
      return jsonb_build_object('ok', false,
        'erro', coalesce(v_credito->>'erro', 'Limite insuficiente'),
        'limite_total', v_credito->'limite_total',
        'disponivel', v_credito->'disponivel',
        'valor_pedido', v_total,
        'excedente', v_credito->'excedente');
    end if;

    v_numero := comercial.hub_fn_gerar_numero();

    update comercial.hub_pedidos set
      numero        = v_numero,
      subtotal      = v_subtotal,
      valor_frete   = v_frete,
      valor_total   = v_total,
      status        = 'em_analise',
      atualizado_em = now()
    where id = p_pedido_id;

    insert into comercial.hub_solicitacoes
      (cliente_id, representante_id, aberto_por_tipo, categoria, referencia_tipo, referencia_id, assunto)
    values (
      v_pedido.cliente_id, v_pedido.representante_id,
      case when v_pedido.origem = 'cliente' then 'cliente' else 'representante' end,
      case when v_pedido.forma_pagamento = 'credix' then 'outro' else 'financeiro' end,
      'pedido', p_pedido_id,
      'Pedido ' || v_numero || ' acima do limite de credito'
    )
    returning id into v_sol_id;

    insert into comercial.hub_solicitacao_mensagens (solicitacao_id, autor_tipo, autor_nome, mensagem)
    values (
      v_sol_id,
      case when v_pedido.origem = 'cliente' then 'cliente' else 'funcionario' end,
      'Sistema',
      'Pedido ' || v_numero || ' no valor de ' || v_total::text ||
        ' excede o limite disponivel (' || coalesce(v_credito->>'disponivel', '0') || '). ' ||
        case when v_pedido.forma_pagamento = 'credix'
          then 'Pagamento via Credix -- aguardando avaliacao do ADM de Vendas junto a fintech.'
          else 'Pedido feito por representante/funcionario Boxer -- aguardando liberacao do financeiro.' end
    );

    return jsonb_build_object(
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
  end if;

  v_numero := comercial.hub_fn_gerar_numero();

  perform comercial.hub_fn_ajustar_credito_grupo(v_pedido.cliente_id, -v_total);

  update comercial.hub_pedidos set
    numero        = v_numero,
    subtotal      = v_subtotal,
    valor_frete   = v_frete,
    valor_total   = v_total,
    status        = 'submetido',
    atualizado_em = now()
  where id = p_pedido_id;

  return jsonb_build_object(
    'ok', true,
    'numero', v_numero,
    'subtotal', v_subtotal,
    'valor_frete', v_frete,
    'valor_total', v_total,
    'itens', v_itens,
    'politica', v_politica
  );
end
$function$;
