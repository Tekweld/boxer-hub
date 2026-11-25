
alter table comercial.orcamentos
  add column if not exists vendedor_erp_id integer;

comment on column comercial.orcamentos.vendedor_erp_id is
  'Zen catalog.person.Person.id do representante, resolvido via hub_clientes.representante_id -> hub_representantes.erp_representante_id no momento da criacao. Gravado em sale.Sale.personSalesperson (campo real confirmado via GET /platform/openapi.json em 2026-11-03 -- nao e so comentario).';
