-- Frete: o Hub NAO cobra (pedido do Andre, 2026-11-26). Ele so INFORMA o valor (hub_pedidos.valor_frete e
-- o aviso da politica) e passa para o ZEN nas observacoes; o time Boxer faz a cobranca.
--  * hub_fn_submeter_pedido: valor_total = subtotal - desconto (sem frete); a reserva de credito usa esse total;
--    retirada/FOB nao tem frete a informar (valor_frete = 0).
--  * hub_fn_validar_politica: texto do aviso deixa de dizer "pague o frete".
-- Corpo igual ao da definicao em producao no momento da migration; so as 3 trocas acima.

CREATE OR REPLACE FUNCTION comercial.hub_fn_submeter_pedido(p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  -- Retirada/FOB: o cliente cuida do transporte, nao ha frete a informar.
  IF v_pedido.frete_modalidade IN ('RETIRADA_BOXER', 'FOB', 'retirada') THEN
    v_frete := 0;
  END IF;
  -- O Hub NAO cobra frete (decisao do Andre, 2026-11-26): valor_frete fica so como INFORMACAO
  -- para o time Boxer cobrar e NAO entra no total nem na reserva de credito.
  v_total := v_subtotal - coalesce(v_pedido.desconto_valor, 0);

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

CREATE OR REPLACE FUNCTION comercial.hub_fn_validar_politica(p_pedido_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_pedido      record;
  v_uf          text;
  v_segmento    text;
  v_subtotal    numeric(12,2);
  v_itens       integer;
  v_so_reposicao boolean;
  v_minimo      numeric(12,2);
  v_minimo_rotulo text;
  v_frete       record;
  v_taxa        numeric(5,2);
  v_violacoes   jsonb := '[]'::jsonb;
  v_avisos      jsonb := '[]'::jsonb;
  v_frete_info  jsonb := 'null'::jsonb;
  v_p           jsonb;
  v_limite_cliente numeric(12,2);
  v_tem_titulo_vencido boolean;
  v_estoque_confiavel boolean;
  v_sem_estoque jsonb;
  v_excecao     jsonb;
BEGIN
  SELECT * INTO v_pedido FROM comercial.hub_pedidos WHERE id = p_pedido_id AND ativo = true;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido nao encontrado');
  END IF;

  IF NOT comercial.hub_pode_acessar_cliente(v_pedido.cliente_id) THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  END IF;

  SELECT jsonb_object_agg(chave, valor) INTO v_p FROM comercial.hub_politica_parametros;

  SELECT c.uf, comercial.hub_fn_segmento(c.canal) INTO v_uf, v_segmento
    FROM comercial.hub_clientes c WHERE c.id = v_pedido.cliente_id;

  SELECT count(*), coalesce(sum(subtotal_item), 0)
    INTO v_itens, v_subtotal
    FROM comercial.hub_pedido_itens WHERE pedido_id = p_pedido_id;

  IF v_itens = 0 THEN
    RETURN jsonb_build_object('ok', false, 'erro', 'Pedido sem itens');
  END IF;

  SELECT EXISTS(SELECT 1 FROM comercial.hub_produtos WHERE estoque_disponivel > 0)
    INTO v_estoque_confiavel;

  IF v_estoque_confiavel THEN
    SELECT jsonb_agg(jsonb_build_object(
             'sku', pr.sku,
             'nome', pr.nome,
             'quantidade_pedida', pi.quantidade,
             'estoque_disponivel', coalesce(pr.estoque_disponivel, 0),
             'previsao_chegada', pr.previsao_chegada))
      INTO v_sem_estoque
      FROM comercial.hub_pedido_itens pi
      JOIN comercial.hub_produtos pr ON pr.id = pi.produto_id
     WHERE pi.pedido_id = p_pedido_id
       AND pi.quantidade > coalesce(pr.estoque_disponivel, 0);

    IF v_sem_estoque IS NOT NULL THEN
      v_avisos := v_avisos || jsonb_build_object(
        'regra', 'estoque',
        'mensagem', format(
          '%s item(ns) sob encomenda -- entram no pedido e serao atendidos conforme previsao de chegada: %s',
          jsonb_array_length(v_sem_estoque),
          (SELECT string_agg(
                    format('%s (pedido %s, disponivel %s)',
                           i->>'sku', i->>'quantidade_pedida', i->>'estoque_disponivel'),
                    '; ')
             FROM jsonb_array_elements(v_sem_estoque) i)),
        'itens', v_sem_estoque);
    END IF;
  ELSE
    v_avisos := v_avisos || jsonb_build_object(
      'regra', 'estoque',
      'mensagem', 'Estoque nao verificado: a sincronizacao com o ERP parece estar fora do ar.');
  END IF;

  SELECT bool_and(coalesce(cc.reposicao, false))
    INTO v_so_reposicao
    FROM comercial.hub_pedido_itens pi
    LEFT JOIN comercial.hub_v_catalogo vc ON vc.produto_id = pi.produto_id
    LEFT JOIN comercial.hub_categoria_config cc ON cc.grupo = vc.categoria_grupo
   WHERE pi.pedido_id = p_pedido_id;

  IF v_pedido.entrega_agendada THEN
    v_minimo := (v_p->>'pedido_minimo_entrega_agendada')::numeric;
    v_minimo_rotulo := 'entrega agendada';
  ELSIF coalesce(v_so_reposicao, false) THEN
    v_minimo := (v_p->>'pedido_minimo_reposicao')::numeric;
    v_minimo_rotulo := 'reposicao';
  ELSE
    v_minimo := (v_p->>'pedido_minimo_normal')::numeric;
    v_minimo_rotulo := 'normal';
  END IF;

  v_excecao := comercial.hub_fn_regra_excecao('pedido_minimo', v_pedido.cliente_id, v_uf, v_segmento);
  IF v_excecao IS NOT NULL AND v_excecao ? 'valor' THEN
    v_minimo := (v_excecao->>'valor')::numeric;
    v_minimo_rotulo := v_minimo_rotulo || ' (excecao comercial)';
  END IF;

  IF v_subtotal < v_minimo THEN
    v_violacoes := v_violacoes || jsonb_build_object(
      'regra', 'pedido_minimo',
      'mensagem', format('Pedido minimo (%s) e R$ %s. Faltam R$ %s.',
                  v_minimo_rotulo, comercial.hub_fn_moeda(v_minimo),
                  comercial.hub_fn_moeda(v_minimo - v_subtotal)),
      'exigido', v_minimo, 'atual', v_subtotal);
  END IF;

  IF v_pedido.forma_pagamento = 'boleto' THEN
    SELECT limite_credito INTO v_limite_cliente
      FROM comercial.hub_clientes WHERE id = v_pedido.cliente_id;

    SELECT EXISTS(
      SELECT 1 FROM comercial.hub_titulos
       WHERE cliente_id = v_pedido.cliente_id AND status = 'vencido' AND ativo = true
    ) INTO v_tem_titulo_vencido;

    v_excecao := comercial.hub_fn_regra_excecao('prazo_especial', v_pedido.cliente_id, v_uf, v_segmento);

    IF coalesce((v_excecao->>'liberar_elegibilidade')::boolean, false) THEN
      IF coalesce(v_limite_cliente, 0) <= 0 OR v_tem_titulo_vencido THEN
        v_avisos := v_avisos || jsonb_build_object(
          'regra', 'boleto_elegibilidade',
          'mensagem', 'Boleto/duplicata liberado por excecao comercial (prazo especial) para este cliente.');
      END IF;
    ELSIF coalesce(v_limite_cliente, 0) <= 0 THEN
      v_violacoes := v_violacoes || jsonb_build_object(
        'regra', 'boleto_elegibilidade',
        'mensagem', 'Boleto/duplicata disponivel apenas para clientes com limite de credito ativo na Boxer.');
    ELSIF v_tem_titulo_vencido THEN
      v_violacoes := v_violacoes || jsonb_build_object(
        'regra', 'boleto_elegibilidade',
        'mensagem', 'Boleto/duplicata bloqueado: cliente tem titulo em atraso. Regularize para liberar.');
    END IF;

    IF coalesce(v_pedido.parcelas, 1) > coalesce(
         (v_excecao->>'max_parcelas')::int,
         (v_p->>'parcelamento_maximo_boleto')::numeric::int) THEN
      v_violacoes := v_violacoes || jsonb_build_object(
        'regra', 'parcelamento',
        'mensagem', format('Boleto/duplicata permite no maximo %sx (28/56/84 dias).',
                    coalesce((v_excecao->>'max_parcelas')::int, (v_p->>'parcelamento_maximo_boleto')::numeric::int)));
    END IF;
  END IF;

  IF coalesce(v_pedido.parcelas, 1) > 1 THEN
    IF v_pedido.forma_pagamento = 'cartao_credito' THEN
      SELECT taxa_percentual INTO v_taxa
        FROM comercial.hub_politica_parcelamento WHERE parcelas = v_pedido.parcelas;

      IF v_taxa IS NULL THEN
        v_violacoes := v_violacoes || jsonb_build_object(
          'regra', 'parcelamento',
          'mensagem', format('Parcelamento em %sx nao previsto na politica (maximo %sx, sem juros).',
                      v_pedido.parcelas, (v_p->>'parcelamento_maximo')::numeric::int));
      ELSIF v_taxa > 0 THEN
        v_avisos := v_avisos || jsonb_build_object(
          'regra', 'parcelamento',
          'mensagem', format('Cartao em %sx tem taxa de %s%%.', v_pedido.parcelas, v_taxa),
          'taxa_percentual', v_taxa);
      END IF;
    ELSIF v_pedido.forma_pagamento = 'boleto' THEN
      IF v_subtotal / v_pedido.parcelas < (v_p->>'valor_minimo_duplicata')::numeric THEN
        v_violacoes := v_violacoes || jsonb_build_object(
          'regra', 'valor_minimo_duplicata',
          'mensagem', format('Cada duplicata precisa ser de no minimo R$ %s. Em %sx daria R$ %s.',
                      comercial.hub_fn_moeda((v_p->>'valor_minimo_duplicata')::numeric),
                      v_pedido.parcelas,
                      comercial.hub_fn_moeda(v_subtotal / v_pedido.parcelas)),
          'exigido', (v_p->>'valor_minimo_duplicata')::numeric,
          'atual', round(v_subtotal / v_pedido.parcelas, 2));
      END IF;
    END IF;
  END IF;

  v_excecao := comercial.hub_fn_regra_excecao('frete_gratis', v_pedido.cliente_id, v_uf, v_segmento);
  IF v_excecao IS NOT NULL THEN
    v_frete_info := jsonb_build_object(
      'tipo', coalesce(v_excecao->>'tipo', 'CIF'),
      'valor', coalesce((v_excecao->>'valor')::numeric, 0),
      'retirada_disponivel', false,
      'envio_disponivel', true,
      'motivo', 'Frete definido por excecao comercial para este cliente.');
    v_avisos := v_avisos || jsonb_build_object('regra', 'frete', 'mensagem', v_frete_info->>'motivo');
  ELSE
    SELECT * INTO v_frete FROM comercial.hub_politica_frete WHERE uf = v_uf;

    IF v_frete.uf IS NULL THEN
      v_avisos := v_avisos || jsonb_build_object(
        'regra', 'frete',
        'mensagem', coalesce('UF ' || v_uf || ' sem regra de frete cadastrada.',
                             'Cliente sem UF: frete a definir.'));
    ELSIF v_frete.tipo = 'FOB' THEN
      v_frete_info := jsonb_build_object('tipo', 'FOB', 'valor', 0,
        'retirada_disponivel', true,
        'envio_disponivel', false,
        'motivo', 'UF FOB: retirada gratuita em Campinas, Sao Paulo ou Guarulhos, ou transportadora indicada pelo cliente. Envio pela Boxer nesta UF nao tem preco fixo -- sob consulta com o comercial.');
      v_avisos := v_avisos || jsonb_build_object('regra', 'frete', 'mensagem', v_frete_info->>'motivo');
    ELSIF v_subtotal >= v_frete.pedido_minimo_cif THEN
      v_frete_info := jsonb_build_object('tipo', 'CIF', 'valor', 0,
        'retirada_disponivel', false,
        'envio_disponivel', true,
        'motivo', format('CIF sem custo: pedido atingiu o minimo de R$ %s para %s.',
                  comercial.hub_fn_moeda(v_frete.pedido_minimo_cif), v_uf));
    ELSE
      v_frete_info := jsonb_build_object('tipo', 'CIF', 'valor', v_frete.frete_fixo,
        'retirada_disponivel', false,
        'envio_disponivel', true,
        'motivo', format('Frete de R$ %s a cobrar pela Boxer (nao incluso no valor do pedido): pedido abaixo do minimo de R$ %s para %s. A equipe Boxer combina o frete com voce.',
                  comercial.hub_fn_moeda(v_frete.frete_fixo),
                  comercial.hub_fn_moeda(v_frete.pedido_minimo_cif), v_uf));
      v_avisos := v_avisos || jsonb_build_object('regra', 'frete',
        'mensagem', v_frete_info->>'motivo', 'valor', v_frete.frete_fixo);
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok',          jsonb_array_length(v_violacoes) = 0,
    'violacoes',   v_violacoes,
    'avisos',      v_avisos,
    'frete',       v_frete_info,
    'subtotal',    v_subtotal,
    'itens',       v_itens,
    'tipo_pedido', v_minimo_rotulo,
    'minimo_exigido', v_minimo
  );
END
$function$;
