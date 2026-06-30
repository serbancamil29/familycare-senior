-- FamilyCare V1.0.46 contact + email outbox patch
-- Database: Caremyla / Schema: familycare

create schema if not exists familycare;

create table if not exists familycare.config_record (
  id bigserial primary key,
  section_key varchar(80) not null,
  payload jsonb not null default '{}'::jsonb,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Nu șterge contactele existente. Completează doar dacă lipsesc.
insert into familycare.config_record(section_key, payload, sort_order)
select 'family-contact', jsonb_build_object(
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
), 1
where not exists (select 1 from familycare.config_record where section_key='family-contact');

insert into familycare.config_record(section_key, payload, sort_order)
select 'email-outbox', jsonb_build_object(
  'Status','pregătit',
  'Tip','exemplu',
  'Către','contact@example.com',
  'Subiect','FamilyCare - notificare pregătită',
  'Mesaj','Acesta este un exemplu de notificare email pregătită. Trimiterea reală necesită SMTP.',
  'Creat la',now()::text
), 1
where not exists (select 1 from familycare.config_record where section_key='email-outbox');

select section_key, payload
from familycare.config_record
where section_key in ('family-contact','notification-channels','email-outbox')
order by section_key, updated_at desc, id desc;
