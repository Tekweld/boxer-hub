-- Pedido do Andre, 2026-11-06: "neste momento" (reversivel) nenhum
-- revendedor deve ver preco subir/descer sozinho conforme o valor do
-- pedido -- todo mundo compra sempre na classe mais cara do segmento dele
-- (F3/H3/E3), sem incentivo automatico de "compre mais pra pagar menos".
-- Parametro novo em hub_politica_parametros (mesmo padrao ja usado pra
-- parcelamento/pedido minimo) -- reversivel so mudando o valor pra 1,
-- sem precisar de deploy.
insert into comercial.hub_politica_parametros (chave, valor, descricao)
values ('progressao_classe_ativa', 0, 'Se 0, todo cliente sem classe_comercial fixa no cadastro cai na classe mais cara (3) independente do valor do pedido. Se 1, classe sobe por valor do pedido (comportamento original). Desligado a pedido do Andre em 2026-11-06.')
on conflict (chave) do nothing;

create or replace function comercial.hub_fn_classe(p_cliente_id uuid, p_valor_pedido numeric default 0)
 returns smallint
 language plpgsql
 stable security definer
 set search_path to ''
as $function$
DECLARE
  v_override smallint;
  v_segmento text;
  v_progressao_ativa boolean;
BEGIN
  SELECT c.classe_comercial, comercial.hub_fn_segmento(c.canal)
    INTO v_override, v_segmento
    FROM comercial.hub_clientes c
   WHERE c.id = p_cliente_id;

  IF v_override IS NOT NULL THEN
    RETURN v_override;
  END IF;

  SELECT (valor <> 0) INTO v_progressao_ativa
    FROM comercial.hub_politica_parametros WHERE chave = 'progressao_classe_ativa';

  IF v_progressao_ativa IS NOT TRUE THEN
    RETURN 3; -- classe mais cara do segmento, sempre -- F3/H3/E3
  END IF;

  IF v_segmento = 'Física' THEN
    RETURN CASE
             WHEN coalesce(p_valor_pedido, 0) > 20000 THEN 1
             WHEN coalesce(p_valor_pedido, 0) > 7000  THEN 2
             ELSE 3
           END;
  END IF;

  -- Ecommerce / Hibrido sem comprovacao de historico
  RETURN 2;
END
$function$;
