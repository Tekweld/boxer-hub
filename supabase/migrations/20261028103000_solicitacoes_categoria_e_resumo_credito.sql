-- Ajustes de feedback no canal unico e no financeiro (2026-10-28):
--
-- 1. hub_solicitacoes ganha "categoria" -- sem isso toda solicitacao cai
--    numa fila indiferenciada e quem responde so descobre do que se trata
--    depois de abrir. Lista curta e generica porque a mesma tabela atende
--    pedido/titulo/nota_fiscal/geral.
--
-- 2. hub_v_financeiro_cliente ganha dias_medio_atraso_vencidos -- a view
--    ja tinha o PIOR atraso (maior_atraso_dias); faltava a media, que e o
--    numero que a aba Credito do financeiro.html pediu para mostrar.

alter table comercial.hub_solicitacoes
  add column categoria varchar(30)
    check (categoria in ('duvida', 'problema_entrega', 'financeiro', 'alteracao_pedido', 'documentacao', 'outro'));

create or replace view comercial.hub_v_financeiro_cliente as
 SELECT c.id AS cliente_id,
    c.razao_social,
    c.cnpj,
    c.limite_credito,
    c.limite_disponivel,
    count(t.id) FILTER (WHERE ((t.status)::text = 'aberto'::text)) AS titulos_abertos,
    count(t.id) FILTER (WHERE ((t.status)::text = 'vencido'::text)) AS titulos_vencidos,
    COALESCE(sum(t.valor_aberto) FILTER (WHERE ((t.status)::text = 'aberto'::text)), (0)::numeric) AS total_a_vencer,
    COALESCE(sum(t.valor_aberto) FILTER (WHERE ((t.status)::text = 'vencido'::text)), (0)::numeric) AS total_vencido,
    COALESCE(max(t.dias_atraso) FILTER (WHERE ((t.status)::text = 'vencido'::text)), 0) AS maior_atraso_dias,
    COALESCE(round(avg(t.dias_atraso) FILTER (WHERE ((t.status)::text = 'vencido'::text))), 0) AS dias_medio_atraso_vencidos
   FROM (comercial.hub_clientes c
     LEFT JOIN comercial.hub_titulos t ON (((t.cliente_id = c.id) AND (t.ativo = true))))
  WHERE (c.ativo = true)
  GROUP BY c.id, c.razao_social, c.cnpj, c.limite_credito, c.limite_disponivel;
