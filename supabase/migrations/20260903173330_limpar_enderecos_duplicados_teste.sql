-- 4 linhas 'entrega' gravadas antes da deduplicacao existir: cada uma e copia
-- identica do endereco 'principal' do mesmo cliente (o personAddress do Zen
-- costuma repetir o endereco do Person). Apaga so a copia, mantendo o principal.
delete from comercial.hub_enderecos a
 where a.tipo <> 'principal'
   and exists (
     select 1 from comercial.hub_enderecos b
      where b.cliente_id = a.cliente_id
        and b.id <> a.id
        and b.tipo = 'principal'
        and upper(trim(coalesce(b.cep,'')))         = upper(trim(coalesce(a.cep,'')))
        and upper(trim(coalesce(b.logradouro,'')))  = upper(trim(coalesce(a.logradouro,'')))
        and upper(trim(coalesce(b.numero,'')))      = upper(trim(coalesce(a.numero,'')))
        and upper(trim(coalesce(b.complemento,''))) = upper(trim(coalesce(a.complemento,'')))
   );