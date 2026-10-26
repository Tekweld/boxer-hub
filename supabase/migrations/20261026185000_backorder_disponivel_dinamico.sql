-- Reabertura da decisao de backorder (2026-10-26, ver tambem a migration
-- 20261026190000). A view sempre devolveu backorder_disponivel fixo em
-- false (decisao de 2026-09-01). Agora calcula dinamicamente: true somente
-- quando o sync de estoque e confiavel e o item realmente esta zerado --
-- mesma condicao que gera status_estoque = 'indisponivel'. Isso liga o
-- badge "Sob encomenda" que catalogo.html e pedidos.html ja sabiam
-- renderizar (ficou dormente desde a reversao).

CREATE OR REPLACE VIEW comercial.hub_v_catalogo AS
WITH preco AS (
  SELECT upper(TRIM(BOTH FROM pp.codigo)) AS sku_norm,
    pc.nome AS categoria_nome,
    pc.id AS categoria_id
   FROM produtos pp
     JOIN categorias pc ON pc.id = pp.categoria_id
  WHERE pp.ativo = true AND pp.tabela_id = 1
), fotos AS (
  SELECT hub_produto_anexos.produto_id,
    string_agg(hub_produto_anexos.storage_path, ','::text ORDER BY hub_produto_anexos.prioridade, hub_produto_anexos.ordem, hub_produto_anexos.id) AS foto_paths,
    count(*) AS foto_count
   FROM comercial.hub_produto_anexos
  WHERE hub_produto_anexos.tipo::text = 'foto'::text AND hub_produto_anexos.renderizavel = true
  GROUP BY hub_produto_anexos.produto_id
), estoque_sync AS (
  SELECT (EXISTS ( SELECT 1
            FROM comercial.hub_produtos
           WHERE hub_produtos.estoque_disponivel > 0)) AS tem_dado
)
SELECT p.id AS produto_id,
  p.sku, p.nome, p.descricao, p.ncm, p.unidade, p.peso_bruto, p.ficha_tecnica, p.o_que_acompanha,
  pr.categoria_nome, pr.categoria_id,
  COALESCE(cc.grupo, 'Outros'::text) AS categoria_grupo,
  COALESCE(cc.grupo_ordem, 99) AS categoria_grupo_ordem,
  COALESCE(cc.ordem, 99) AS categoria_ordem,
  COALESCE(cc.oculta, false) AS categoria_oculta,
  p.estoque_disponivel,
  CASE
    WHEN NOT es.tem_dado THEN 'sem_info'::text
    WHEN p.estoque_disponivel IS NULL THEN 'sem_info'::text
    WHEN p.estoque_disponivel > COALESCE(p.estoque_minimo, 0) THEN 'disponivel'::text
    WHEN p.estoque_disponivel > 0 THEN 'baixo'::text
    ELSE 'indisponivel'::text
  END AS status_estoque,
  CASE
    WHEN NOT es.tem_dado THEN false
    WHEN p.estoque_disponivel IS NULL THEN false
    WHEN p.estoque_disponivel > COALESCE(p.estoque_minimo, 0) THEN false
    WHEN p.estoque_disponivel > 0 THEN false
    ELSE true
  END AS backorder_disponivel,
  p.previsao_chegada,
  f.foto_paths,
  COALESCE(f.foto_count, 0::bigint) AS foto_count,
  p.destaque, p.ativo
 FROM comercial.hub_produtos p
   CROSS JOIN estoque_sync es
   JOIN preco pr ON pr.sku_norm = upper(TRIM(BOTH FROM p.sku))
   LEFT JOIN comercial.hub_categoria_config cc ON cc.categoria_nome = pr.categoria_nome::text AND cc.ativo = true
   LEFT JOIN fotos f ON f.produto_id = p.id
WHERE p.ativo = true;
