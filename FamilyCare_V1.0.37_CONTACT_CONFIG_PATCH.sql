-- FamilyCare V1.0.40 contact defaults for senior actions
-- Run on database Caremyla / schema familycare if you want default call/message contacts.
insert into familycare.config_record(section_key, payload, sort_order)
select 'family-contact', jsonb_build_object(
  'Nume', 'Ioana Popescu',
  'Telefon', '0700000000',
  'Email', 'contact@example.com',
  'Mesaj implicit', 'Am nevoie de ajutor. Te rog să mă contactezi.'
), 1
where not exists (select 1 from familycare.config_record where section_key='family-contact');

insert into familycare.config_record(section_key, payload, sort_order)
select 'mail-center', jsonb_build_object('Cont','familie@example.com','Tip','inbox read-only','Status','activ','Detalii','Mesaje de la medic/farmacie/îngrijitor'), 1
where not exists (select 1 from familycare.config_record where section_key='mail-center');
