-- hub_carteira estava com 0 linhas (achado investigando o caso Diafer,
-- 2026-11-03), apesar de 7208 hub_clientes.representante_id ja preenchidos
-- pelo sync do ZEN. hub_pode_acessar_cliente() e a RLS de hub_clientes/
-- hub_titulos/hub_pedidos/hub_notas_fiscais dependem de hub_carteira pra
-- tipo='representante' -- sem isso, QUALQUER representante logado (nao so
-- admin testando) veria zero pedidos/titulos/NFs, mesmo sendo o dono real
-- da carteira. Backfill idempotente (on conflict do nothing, a unique
-- constraint ja existe em (representante_id, cliente_id)).
insert into comercial.hub_carteira (representante_id, cliente_id)
select representante_id, id
from comercial.hub_clientes
where representante_id is not null and ativo = true
on conflict (representante_id, cliente_id) do nothing;
