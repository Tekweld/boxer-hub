-- Base de indicadores do Hub alimentada pelo BAV (decisao do Andre, 2026-11-27: "BAV > Hub").
-- O BAV (bsis.db: historico 2018+ e ZEN) e a fonte do historico por cliente x produto x mes, da curva ABC e do status do cliente.
-- Granularidade CNPJ (loja): a entidade (grupo/empresa/loja) e resolvida na leitura, por hub_clientes.entidade_key.
-- Receita LIQUIDA = vendas + devolucoes (tipo_operacao 'Venda%' e 'Devolucao%'); remessas/brindes/amostras ficam fora.
-- RLS ligado e sem politicas: so as funcoes SECURITY DEFINER (api/_indicadores.js) leem estas tabelas.

create table if not exists comercial.hub_ind_meta (
  chave text primary key,
  valor text,
  atualizado_em timestamptz not null default now()
);

create table if not exists comercial.hub_ind_produto (
  codigo text primary key,
  nome text,
  categoria text,
  situacao text,                 -- em_linha | sem_tabela_precos (BAV)
  fat_12m numeric(14,2) not null default 0,
  qtd_12m numeric(14,2) not null default 0,
  clientes_12m int not null default 0,
  classe_abc char(1),            -- A ate 80% | B ate 95% | C (sobre produtos em linha, receita liquida 12m)
  primeira_venda date,
  ultima_venda date
);

create table if not exists comercial.hub_ind_cnpj (
  cnpj text primary key,         -- so digitos
  nome text,
  uf text,
  cidade text,
  segmento text,
  entidade_bav text,             -- G:<grupo> | E:<raiz> | C:<cnpj> (regra do BAV)
  grupo_bav text,
  vendedor_real text,            -- quem mais vendeu para a entidade (regra do BAV)
  primeira_compra date,
  ultima_compra date
);

create table if not exists comercial.hub_ind_cnpj_mes (
  cnpj text not null,
  ym text not null,              -- AAAA-MM
  valor numeric(14,2) not null default 0,
  qtd numeric(14,2) not null default 0,
  nfs int not null default 0,
  primary key (cnpj, ym)
);

create table if not exists comercial.hub_ind_cnpj_produto (
  cnpj text not null,
  codigo text not null,
  valor_12m numeric(14,2) not null default 0,
  qtd_12m numeric(14,2) not null default 0,
  valor_ant numeric(14,2) not null default 0,   -- 12 meses anteriores aos ultimos 12
  qtd_ant numeric(14,2) not null default 0,
  primeira date,
  ultima date,
  primary key (cnpj, codigo)
);
create index if not exists ix_hub_ind_cnpj_produto_codigo on comercial.hub_ind_cnpj_produto (codigo);
create index if not exists ix_hub_ind_cnpj_mes_ym on comercial.hub_ind_cnpj_mes (ym);

alter table comercial.hub_ind_meta enable row level security;
alter table comercial.hub_ind_produto enable row level security;
alter table comercial.hub_ind_cnpj enable row level security;
alter table comercial.hub_ind_cnpj_mes enable row level security;
alter table comercial.hub_ind_cnpj_produto enable row level security;
revoke all on comercial.hub_ind_meta, comercial.hub_ind_produto, comercial.hub_ind_cnpj, comercial.hub_ind_cnpj_mes, comercial.hub_ind_cnpj_produto from public, anon, authenticated;
