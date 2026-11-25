-- Transparencia de preco no carrinho: "faltam R$X para a proxima faixa".
--
-- Fonte unica da regra vive em hub_fn_classe (segmento Fisica > 20k = classe 1,
-- > 7k = classe 2, resto = classe 3). Aqui devolvemos, para o valor atual do
-- carrinho, se ha proxima faixa alcancavel e o quanto falta.
--
-- Nao calcula "ganho estimado" -- varia por produto e passar valor aproximado
-- prometeria coisa que nem sempre se confirma. A frase "faltam R$X para faixa
-- melhor de desconto" ja e motivador o bastante e nao mente.

create or replace function comercial.hub_fn_faixa_proxima(
  p_cliente_id uuid,
  p_valor_pedido numeric default 0
) returns jsonb
language plpgsql stable security definer
set search_path to ''
as $$
declare
  v_segmento text;
  v_classe_atual smallint;
  v_override smallint;
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

  -- Cliente com classe fixa (override do admin) nao tem faixa a subir por
  -- valor do pedido -- so o admin muda essa classe.
  if v_override is not null or v_segmento is null or v_segmento <> 'Física' then
    return jsonb_build_object('ok', true, 'aplicavel', false);
  end if;

  v_classe_atual := comercial.hub_fn_classe(p_cliente_id, p_valor_pedido);

  -- Parametros com fallback -- se hub_politica_parametros for editado a
  -- funcao pega o novo valor na hora, sem redeploy.
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
    -- Classe 1 ja e a melhor
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
end $$;

grant execute on function comercial.hub_fn_faixa_proxima(uuid, numeric) to anon, authenticated;

comment on function comercial.hub_fn_faixa_proxima(uuid, numeric) is
  'Retorna, para segmento Fisica, quanto falta em valor do pedido para pular para a proxima classe de preco. Aplicavel=false para Ecommerce/Hibrido/override.';