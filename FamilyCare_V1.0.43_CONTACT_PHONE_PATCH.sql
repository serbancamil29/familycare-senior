
-- FamilyCare V1.0.46 contact phone configuration patch
-- Run manually in pgAdmin on database: Caremyla, schema: familycare

create schema if not exists familycare;

create table if not exists familycare.config_record (
  id bigserial primary key,
  section_key varchar(80) not null,
  payload jsonb not null default '{}'::jsonb,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- contact numbers used by Senior buttons: Sună familia / Trimite mesaj / Am nevoie de ajutor
with removed as (
  delete from familycare.config_record where section_key='family-contact'
)
insert into familycare.config_record(section_key, payload, sort_order)
values (
  'family-contact',
  jsonb_build_object(
    'Nume','Contacte familie',
    'Nume principal','Ioana Popescu',
    'Telefon principal','0700000001',
    'Nume secundar','Mihai Popescu',
    'Telefon secundar','0700000002',
    'Nume al treilea','Contact rezervă',
    'Telefon al treilea','0700000003',
    'Email','contact@example.com',
    'Mesaj SMS','Te rog să mă contactezi.',
    'Mesaj ajutor','Am nevoie de ajutor. Te rog să mă contactezi urgent.'
  ),
  1
);

-- optional display in notification channels
update familycare.config_record
set payload = payload || jsonb_build_object(
  'Telefon principal','0700000001',
  'Telefon secundar','0700000002',
  'Telefon al treilea','0700000003'
), updated_at=now()
where section_key='notification-channels'
  and payload->>'Canal' in ('Telefon / SMS','SMS','Telefon');

select section_key, payload
from familycare.config_record
where section_key in ('family-contact','notification-channels')
order by section_key, sort_order, id;
