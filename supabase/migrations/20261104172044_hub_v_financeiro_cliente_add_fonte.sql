create or replace view comercial.hub_v_financeiro_cliente as
 SELECT c.id AS cliente_id,
    c.razao_social,
    c.cnpj,
    c.limite_credito,
    c.limite_disponivel,
    count(t.id) FILTER (WHERE t.status::text = 'aberto'::text) AS titulos_abertos,
    count(t.id) FILTER (WHERE t.status::text = 'vencido'::text) AS titulos_vencidos,
    COALESCE(sum(t.valor_aberto) FILTER (WHERE t.status::text = 'aberto'::text), 0::numeric) AS total_a_vencer,
    COALESCE(sum(t.valor_aberto) FILTER (WHERE t.status::text = 'vencido'::text), 0::numeric) AS total_vencido,
    COALESCE(max(t.dias_atraso) FILTER (WHERE t.status::text = 'vencido'::text), 0) AS maior_atraso_dias,
    COALESCE(round(avg(t.dias_atraso) FILTER (WHERE t.status::text = 'vencido'::text)), 0::numeric) AS dias_medio_atraso_vencidos,
    c.limite_credito_fonte
   FROM comercial.hub_clientes c
     LEFT JOIN comercial.hub_titulos t ON t.cliente_id = c.id AND t.ativo = true
  WHERE c.ativo = true
  GROUP BY c.id, c.razao_social, c.cnpj, c.limite_credito, c.limite_disponivel, c.limite_credito_fonte;
