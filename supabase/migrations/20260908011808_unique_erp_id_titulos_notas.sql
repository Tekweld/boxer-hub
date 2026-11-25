-- Chave de upsert para o sync-financeiro. Igual ao padrao ja usado em
-- hub_enderecos.erp_endereco_id.
create unique index if not exists hub_titulos_erp_titulo_id_key
  on comercial.hub_titulos (erp_titulo_id) where erp_titulo_id is not null;

create unique index if not exists hub_notas_fiscais_erp_nf_id_key
  on comercial.hub_notas_fiscais (erp_nf_id) where erp_nf_id is not null;