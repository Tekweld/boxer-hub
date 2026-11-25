-- Sem isto o banner "Faltam R$X pra proxima faixa" continuaria aparecendo
-- mesmo com a progressao desligada (hub_fn_classe sempre devolve 3 agora,
-- mas esta funcao nao sabia disso e calculava a falta normalmente -- bug
-- que o Andre teria visto na hora, achado revisando o pedido real dele).
create or replace function comercial.hub_fn_faixa_proxima(p_cliente_id uuid, p_valor_pedido numeric default 0)
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
declare
  v_segmento text;
  v_classe_atual smallint;
  v_override smallint;
  v_progressao_ativa boolean;
  v_lim2 numeric;
  v_lim1 numeric;
  v_falta numeric;
  v_proxima_classe smallint;
begin
  if not comercial.hub_pode_acessar_cliente(p_cliente_id) then
    return jsonb_build_object('ok', false, 'erro', 'Acesso negado');
  end if;

  select comercial.hub_fn_segmento(c.canal), c.classe_comercial
    into v_segmento, v_override
    from comercial.hub_clientes c
   where c.id = p_cliente_id and c.ativo = true;

  select (valor <> 0) into v_progressao_ativa
    from comercial.hub_politica_parametros where chave = 'progressao_classe_ativa';

  -- Cliente com classe fixa (override do admin), progressao desligada, ou
  -- segmento que nao sobe por valor: nao ha faixa a subir.
  if v_override is not null or v_segmento is null or v_segmento <> 'Física' or v_progressao_ativa is not true then
    return jsonb_build_object('ok', true, 'aplicavel', false);
  end if;

  v_classe_atual := comercial.hub_fn_classe(p_cliente_id, p_valor_pedido);

  select (valor)::numeric into v_lim2
    from comercial.hub_politica_parametros where chave = 'classe_fisica_limite_2';
  select (valor)::numeric into v_lim1
    from comercial.hub_politica_parametros where chave = 'classe_fisica_limite_1';
  v_lim2 := coalesce(v_lim2, 7000);
  v_lim1 := coalesce(v_lim1, 20000);

  if v_classe_atual = 3 then
    v_falta := v_lim2 - coalesce(p_valor_pedido, 0);
    v_proxima_classe := 2;
  elsif v_classe_atual = 2 then
    v_falta := v_lim1 - coalesce(p_valor_pedido, 0);
    v_proxima_classe := 1;
  else
    return jsonb_build_object(
      'ok', true, 'aplicavel', true,
      'classe_atual', v_classe_atual,
      'melhor_faixa', true,
      'mensagem', 'Voce ja esta na melhor faixa de preco.');
  end if;

  return jsonb_build_object(
    'ok', true, 'aplicavel', true,
    'classe_atual', v_classe_atual,
    'proxima_classe', v_proxima_classe,
    'falta', greatest(v_falta, 0),
    'limite_proxima_faixa', case when v_proxima_classe = 2 then v_lim2 else v_lim1 end,
    'mensagem', 'Faltam R$ ' ||
                to_char(greatest(v_falta, 0), 'FM999G999G990D00') ||
                ' para a proxima faixa de desconto.'
  );
end $function$;
