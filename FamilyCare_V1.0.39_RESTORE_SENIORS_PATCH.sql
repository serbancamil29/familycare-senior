-- FamilyCare V1.0.40 - restore senior demo data for branch Parintii mei
-- Database: Caremyla
-- Schema: familycare
-- Run manually in pgAdmin Query Tool.

begin;

create schema if not exists familycare;

-- Compatibility columns used by the API/UI.
alter table if exists familycare.managed_entity add column if not exists name varchar(200);
alter table if exists familycare.managed_entity add column if not exists display_name varchar(200);
alter table if exists familycare.managed_entity add column if not exists branch_name varchar(200);
alter table if exists familycare.managed_entity add column if not exists address_details text;
alter table if exists familycare.managed_entity add column if not exists responsible_name varchar(200);

-- Ensure main header exists.
insert into familycare.care_header(header_code, name, context_type, coordinator_name, city, description, active)
values ('CH-RO-0001', 'Reteaua Popescu', 'Familie proprie', 'Ioana Popescu', 'Iasi', 'Header principal pentru familie.', true)
on conflict (header_code) do update set
  name = excluded.name,
  context_type = excluded.context_type,
  coordinator_name = excluded.coordinator_name,
  city = excluded.city,
  description = excluded.description,
  active = true,
  updated_at = now();

-- Ensure branch Parintii mei exists.
insert into familycare.care_branch(care_header_id, branch_code, name, branch_type, coordinator_name, city, description, sort_order, active)
select h.id, 'CB-0001', 'Părinții mei', 'familie_seniori', 'Ioana Popescu', 'Iasi', 'Ramificatie pentru parintii mei.', 1, true
from familycare.care_header h
where h.header_code = 'CH-RO-0001'
on conflict (branch_code) do update set
  care_header_id = excluded.care_header_id,
  name = excluded.name,
  branch_type = excluded.branch_type,
  coordinator_name = excluded.coordinator_name,
  city = excluded.city,
  description = excluded.description,
  sort_order = excluded.sort_order,
  active = true,
  updated_at = now();

-- Restore both seniors in the same branch.
with hb as (
  select h.id as header_id, b.id as branch_id
  from familycare.care_header h
  join familycare.care_branch b on b.care_header_id = h.id
  where h.header_code = 'CH-RO-0001' and b.branch_code = 'CB-0001'
)
insert into familycare.managed_entity(
  care_header_id, care_branch_id, entity_code, entity_type, display_name, name,
  gender, birth_date, phone, email, allows_senior_screen,
  country, county_or_sector, city, street, street_no, building, entrance, floor, apartment, postal_code,
  access_details, address_notes, notes, branch_name, address_details, responsible_name, active
)
select hb.header_id, hb.branch_id, v.entity_code, v.entity_type, v.display_name, v.display_name,
       v.gender, v.birth_date::date, v.phone, null, true,
       'Romania', 'Iasi', 'Iasi', 'Strada Florilor', '12', 'B1', 'A', '2', v.apartment, '700000',
       v.access_details, v.address_notes, v.notes, 'Părinții mei', v.full_address, 'Ioana Popescu', true
from hb
cross join (values
  ('ME-0001','senioară','Maria Popescu','F','1948-04-12','0700000101','10','Cheie la vecina de la ap. 8','Interfon Popescu','Tratament tensiune si vizite regulate.','Romania, Iasi, Strada Florilor nr. 12, bloc B1, scara A, etaj 2, ap. 10'),
  ('ME-0003','senior','Ion Popescu','M','1945-02-20','0700000103','8','Suna inainte de vizita','Interfon Popescu','Tratament tensiune si vizite regulate.','Romania, Iasi, Strada Florilor nr. 12, bloc B1, scara A, etaj 2, ap. 8')
) as v(entity_code, entity_type, display_name, gender, birth_date, phone, apartment, access_details, address_notes, notes, full_address)
on conflict (entity_code) do update set
  care_header_id = excluded.care_header_id,
  care_branch_id = excluded.care_branch_id,
  entity_type = excluded.entity_type,
  display_name = excluded.display_name,
  name = excluded.name,
  gender = excluded.gender,
  birth_date = excluded.birth_date,
  phone = excluded.phone,
  allows_senior_screen = true,
  country = excluded.country,
  county_or_sector = excluded.county_or_sector,
  city = excluded.city,
  street = excluded.street,
  street_no = excluded.street_no,
  building = excluded.building,
  entrance = excluded.entrance,
  floor = excluded.floor,
  apartment = excluded.apartment,
  postal_code = excluded.postal_code,
  access_details = excluded.access_details,
  address_notes = excluded.address_notes,
  notes = excluded.notes,
  branch_name = excluded.branch_name,
  address_details = excluded.address_details,
  responsible_name = excluded.responsible_name,
  active = true,
  updated_at = now();

-- Refresh configuration rows displayed in Configurari.
delete from familycare.config_record where section_key in ('managed-entities','care-persons','branches','entity-types');

insert into familycare.config_record(section_key, payload, sort_order) values
('branches', jsonb_build_object('Denumire ramificație','Părinții mei','Tip','Familie seniori','Oraș','Iași','Coordonator','Ioana Popescu'), 1),
('managed-entities', jsonb_build_object('Denumire','Maria Popescu','Tip entitate','senioară','Ramificație','Părinții mei','Adresă / detalii','Romania, Iasi, Strada Florilor nr. 12, bloc B1, scara A, etaj 2, ap. 10','Responsabil','Ioana Popescu'), 1),
('managed-entities', jsonb_build_object('Denumire','Ion Popescu','Tip entitate','senior','Ramificație','Părinții mei','Adresă / detalii','Romania, Iasi, Strada Florilor nr. 12, bloc B1, scara A, etaj 2, ap. 8','Responsabil','Ioana Popescu'), 2),
('entity-types', jsonb_build_object('Tip entitate','senior','Categorie','persoană','Are domiciliu/adresă','da','Interfață dedicată','da','Detalii','Ecran senior activ'), 1),
('entity-types', jsonb_build_object('Tip entitate','senioară','Categorie','persoană','Are domiciliu/adresă','da','Interfață dedicată','da','Detalii','Ecran senior activ'), 2);

commit;

select e.entity_code, coalesce(e.name, e.display_name) as senior, e.entity_type, b.branch_code, b.name as ramificatie
from familycare.managed_entity e
left join familycare.care_branch b on b.id = e.care_branch_id
where e.entity_type ilike 'senior%'
order by e.entity_code;
