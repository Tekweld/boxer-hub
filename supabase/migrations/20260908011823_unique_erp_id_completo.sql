-- PostgREST on_conflict nao usa a clausula WHERE do indice parcial, entao
-- o partial index anterior nao serve de alvo. Trocar por completo -- as duas
-- tabelas estao vazias hoje, entao nao ha conflito de dado.
drop index if exists comercial.hub_titulos_erp_titulo_id_key;
drop index if exists comercial.hub_notas_fiscais_erp_nf_id_key;
create unique index hub_titulos_erp_titulo_id_key
  on comercial.hub_titulos (erp_titulo_id);
create unique index hub_notas_fiscais_erp_nf_id_key
  on comercial.hub_notas_fiscais (erp_nf_id);