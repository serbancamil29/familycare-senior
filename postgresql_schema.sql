-- FamilyCare V1.0.64 FULL RESET schema + demo data
-- Database: Render PostgreSQL or local Caremyla
-- Schema created: familycare
-- WARNING: This script deletes everything from schema familycare and recreates it from zero.
-- Run manually in pgAdmin Query Tool while connected to database Caremyla.

begin;

drop schema if exists familycare cascade;
create schema familycare;
set search_path to familycare;

-- =========================================================
-- Common trigger for updated_at
-- =========================================================
create or replace function familycare.set_updated_at()
returns trigger
language plpgsql
as $$
begin
    new.updated_at = now();
    return new;
end;
$$;

-- =========================================================
-- Users / members
-- =========================================================
create table familycare.app_user (
    id bigserial primary key,
    user_code varchar(50) not null unique,
    display_name varchar(200) not null,
    email varchar(250),
    phone varchar(50),
    role_key varchar(80) not null default 'family_member',
    active boolean not null default true,

    country varchar(100),
    county_or_sector varchar(100),
    city varchar(150),
    street varchar(200),
    street_no varchar(50),
    building varchar(50),
    entrance varchar(50),
    floor varchar(50),
    apartment varchar(50),
    postal_code varchar(30),
    access_details text,
    address_notes text,

    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_app_user_updated before update on familycare.app_user for each row execute function familycare.set_updated_at();

-- =========================================================
-- Main header / tenant and branches
-- =========================================================
create table familycare.care_header (
    id bigserial primary key,
    header_code varchar(50) not null unique,
    name varchar(200) not null,
    context_type varchar(100) not null default 'familie_proprie',
    coordinator_user_id bigint references familycare.app_user(id),
    coordinator_name varchar(200),
    city varchar(150),
    description text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_care_header_updated before update on familycare.care_header for each row execute function familycare.set_updated_at();

create table familycare.care_branch (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    branch_code varchar(50) not null unique,
    name varchar(200) not null,
    branch_type varchar(100) not null default 'familie',
    coordinator_user_id bigint references familycare.app_user(id),
    coordinator_name varchar(200),
    city varchar(150),
    description text,
    sort_order int not null default 0,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index ix_care_branch_header on familycare.care_branch(care_header_id, sort_order, id);
create trigger trg_care_branch_updated before update on familycare.care_branch for each row execute function familycare.set_updated_at();

create table familycare.branch_member (
    id bigserial primary key,
    care_branch_id bigint not null references familycare.care_branch(id) on delete cascade,
    user_id bigint not null references familycare.app_user(id) on delete cascade,
    member_role varchar(100) not null default 'family_member',
    is_coordinator boolean not null default false,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    unique(care_branch_id, user_id)
);

-- =========================================================
-- Generic entities tracked by the app
-- Examples: senior, seniora, copil, beneficiar, locuinta, animal, vehicul, proiect, altceva.
-- Senior screen is shown only when allows_senior_screen = true.
-- =========================================================
create table familycare.managed_entity (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    care_branch_id bigint references familycare.care_branch(id) on delete set null,
    entity_code varchar(50) not null unique,
    entity_type varchar(80) not null,
    display_name varchar(200) not null,
    gender varchar(30),
    birth_date date,
    phone varchar(50),
    email varchar(250),
    allows_senior_screen boolean not null default false,

    country varchar(100),
    county_or_sector varchar(100),
    city varchar(150),
    street varchar(200),
    street_no varchar(50),
    building varchar(50),
    entrance varchar(50),
    floor varchar(50),
    apartment varchar(50),
    postal_code varchar(30),
    access_details text,
    address_notes text,

    notes text,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index ix_managed_entity_header_branch on familycare.managed_entity(care_header_id, care_branch_id, entity_type, active);
create trigger trg_managed_entity_updated before update on familycare.managed_entity for each row execute function familycare.set_updated_at();

-- Compatibility table for older screens that still use care_person wording.
create view familycare.care_person as
select
    id,
    care_header_id,
    care_branch_id,
    entity_code as person_code,
    entity_type as person_type,
    display_name as full_name,
    gender,
    birth_date,
    phone,
    email,
    allows_senior_screen,
    country,
    county_or_sector,
    city,
    street,
    street_no,
    building,
    entrance,
    floor,
    apartment,
    postal_code,
    access_details,
    address_notes,
    notes,
    active,
    created_at,
    updated_at
from familycare.managed_entity;

create table familycare.care_relationship (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    from_entity_id bigint references familycare.managed_entity(id) on delete cascade,
    to_entity_id bigint references familycare.managed_entity(id) on delete cascade,
    from_user_id bigint references familycare.app_user(id) on delete cascade,
    to_user_id bigint references familycare.app_user(id) on delete cascade,
    relationship_type varchar(100) not null,
    notes text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);
create index ix_care_relationship_header on familycare.care_relationship(care_header_id, active);

-- =========================================================
-- Doctors and providers
-- =========================================================
create table familycare.doctor (
    id bigserial primary key,
    doctor_code varchar(50) not null unique,
    full_name varchar(200) not null,
    specialty varchar(150),
    phone varchar(50),
    email varchar(250),
    clinic_name varchar(200),

    country varchar(100),
    county_or_sector varchar(100),
    city varchar(150),
    street varchar(200),
    street_no varchar(50),
    building varchar(50),
    entrance varchar(50),
    floor varchar(50),
    apartment varchar(50),
    postal_code varchar(30),
    access_details text,
    address_notes text,

    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_doctor_updated before update on familycare.doctor for each row execute function familycare.set_updated_at();

create table familycare.provider (
    id bigserial primary key,
    provider_code varchar(50) not null unique,
    name varchar(200) not null,
    provider_type varchar(100) not null,
    phone varchar(50),
    email varchar(250),

    country varchar(100),
    county_or_sector varchar(100),
    city varchar(150),
    street varchar(200),
    street_no varchar(50),
    building varchar(50),
    entrance varchar(50),
    floor varchar(50),
    apartment varchar(50),
    postal_code varchar(30),
    access_details text,
    address_notes text,

    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_provider_updated before update on familycare.provider for each row execute function familycare.set_updated_at();

-- =========================================================
-- Medication / medical recommendations
-- =========================================================
create table familycare.medication (
    id bigserial primary key,
    entity_id bigint not null references familycare.managed_entity(id) on delete cascade,
    medication_name varchar(200) not null,
    dose varchar(100),
    instructions text,
    prescribing_doctor_id bigint references familycare.doctor(id) on delete set null,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_medication_updated before update on familycare.medication for each row execute function familycare.set_updated_at();

create table familycare.doctor_recommendation (
    id bigserial primary key,
    entity_id bigint not null references familycare.managed_entity(id) on delete cascade,
    doctor_id bigint references familycare.doctor(id) on delete set null,
    recommendation_title varchar(200) not null,
    recommendation_text text,
    recommendation_date date not null default current_date,
    valid_until date,
    can_generate_task boolean not null default true,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_doctor_recommendation_updated before update on familycare.doctor_recommendation for each row execute function familycare.set_updated_at();

-- =========================================================
-- Recurring agenda model
-- All calendar items are recurring task series: treatment, visit, recommendation, house, pet, vehicle, project.
-- =========================================================
create table familycare.calendar_series (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    care_branch_id bigint references familycare.care_branch(id) on delete set null,
    entity_id bigint references familycare.managed_entity(id) on delete set null,
    section_key varchar(80) not null default 'agenda',
    task_type varchar(100) not null default 'general',
    title varchar(200) not null,
    description text,
    start_date date not null,
    end_date date,
    start_time time,
    recurrence_rule varchar(100) not null default 'selected_weekdays',
    repeat_every_days int,
    active_weekdays varchar(80) default '',
    escalation_minutes int default 30,
    email_on_create boolean not null default false,
    email_on_finish boolean not null default false,
    email_recipients text,
    status varchar(50) not null default 'active',
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index ix_calendar_series_header on familycare.calendar_series(care_header_id, care_branch_id, entity_id, active);
create trigger trg_calendar_series_updated before update on familycare.calendar_series for each row execute function familycare.set_updated_at();

create table familycare.calendar_occurrence (
    id bigserial primary key,
    calendar_series_id bigint not null references familycare.calendar_series(id) on delete cascade,
    occurrence_date date not null,
    occurrence_time time,
    status varchar(50) not null default 'pending',
    confirmed_by_user_id bigint references familycare.app_user(id) on delete set null,
    confirmed_at timestamptz,
    notes text,
    created_at timestamptz not null default now(),
    unique(calendar_series_id, occurrence_date, occurrence_time)
);
create index ix_calendar_occurrence_date on familycare.calendar_occurrence(occurrence_date, status);

create table familycare.task_email_notification (
    id bigserial primary key,
    calendar_series_id bigint references familycare.calendar_series(id) on delete cascade,
    event_type varchar(50) not null,
    recipient_email varchar(250) not null,
    subject text,
    body text,
    status varchar(50) not null default 'pending',
    created_at timestamptz not null default now(),
    sent_at timestamptz
);

-- =========================================================
-- Journal and alerts
-- =========================================================
create table familycare.journal_entry (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    care_branch_id bigint references familycare.care_branch(id) on delete set null,
    entity_id bigint references familycare.managed_entity(id) on delete set null,
    author_user_id bigint references familycare.app_user(id) on delete set null,
    entry_date date not null default current_date,
    mood_score int,
    vitality_score int,
    title varchar(200),
    body text not null,
    tags varchar(300),
    created_at timestamptz not null default now()
);
create index ix_journal_header_date on familycare.journal_entry(care_header_id, entry_date desc);

create table familycare.alert_rule (
    id bigserial primary key,
    care_header_id bigint references familycare.care_header(id) on delete cascade,
    rule_code varchar(50) not null unique,
    name varchar(200) not null,
    condition_text text,
    escalation_minutes int default 30,
    active boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create trigger trg_alert_rule_updated before update on familycare.alert_rule for each row execute function familycare.set_updated_at();

create table familycare.alert (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    care_branch_id bigint references familycare.care_branch(id) on delete set null,
    entity_id bigint references familycare.managed_entity(id) on delete set null,
    alert_rule_id bigint references familycare.alert_rule(id) on delete set null,
    severity varchar(50) not null default 'medium',
    title varchar(200) not null,
    message text,
    status varchar(50) not null default 'open',
    created_at timestamptz not null default now(),
    closed_at timestamptz
);
create index ix_alert_open on familycare.alert(care_header_id, status, severity);

-- =========================================================
-- Mail center read-only model
-- =========================================================
create table familycare.mail_account (
    id bigserial primary key,
    care_header_id bigint references familycare.care_header(id) on delete cascade,
    account_code varchar(50) not null unique,
    provider varchar(100) not null,
    email varchar(250) not null,
    read_only boolean not null default true,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create table familycare.mail_message (
    id bigserial primary key,
    mail_account_id bigint references familycare.mail_account(id) on delete cascade,
    sender_email varchar(250),
    sender_name varchar(200),
    subject text,
    received_at timestamptz not null default now(),
    body_preview text,
    source_type varchar(80),
    is_read boolean not null default false,
    created_at timestamptz not null default now()
);
create index ix_mail_message_received on familycare.mail_message(received_at desc);

create table familycare.mail_task_suggestion (
    id bigserial primary key,
    mail_message_id bigint references familycare.mail_message(id) on delete cascade,
    suggested_title varchar(200) not null,
    suggested_date date,
    suggested_time time,
    status varchar(50) not null default 'proposed',
    created_at timestamptz not null default now()
);

-- =========================================================
-- Documents / subscription / settings
-- =========================================================
create table familycare.document (
    id bigserial primary key,
    care_header_id bigint not null references familycare.care_header(id) on delete cascade,
    care_branch_id bigint references familycare.care_branch(id) on delete set null,
    entity_id bigint references familycare.managed_entity(id) on delete set null,
    document_type varchar(100),
    title varchar(200) not null,
    file_name varchar(300),
    notes text,
    created_at timestamptz not null default now()
);

create table familycare.subscription_plan (
    id bigserial primary key,
    plan_code varchar(50) not null unique,
    name varchar(150) not null,
    monthly_price_eur numeric(10,2) not null default 0,
    max_entities int,
    details text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

-- Generic configuration table used by prototype Configurations screen.
create table familycare.config_record (
    id bigserial primary key,
    section_key varchar(80) not null,
    payload jsonb not null default '{}'::jsonb,
    sort_order int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index ix_config_record_section on familycare.config_record(section_key, sort_order, id);
create trigger trg_config_record_updated before update on familycare.config_record for each row execute function familycare.set_updated_at();

-- =========================================================
-- Demo data
-- =========================================================
insert into familycare.app_user(user_code, display_name, email, phone, role_key, country, county_or_sector, city, street, street_no)
values
('USR-0001','Ioana Popescu','ioana@example.com','0700000001','coordinator','Romania','Bucuresti','Bucuresti','Strada Exemplu','10'),
('USR-0002','Mihai Ingrijitor','mihai@example.com','0700000002','caregiver','Romania','Iasi','Iasi','Strada Pacii','5'),
('USR-0003','Andrei Ionescu','andrei@example.com','0700000003','family_member','Romania','Cluj','Cluj-Napoca','Strada Memorandumului','2');

insert into familycare.care_header(header_code, name, context_type, coordinator_user_id, coordinator_name, city, description)
select 'CH-RO-0001', 'Reteaua Popescu', 'familie_proprie', u.id, u.display_name, 'Iasi', 'Header principal pentru familie, ramificatii, persoane si alte entitati urmarite.'
from familycare.app_user u
where u.user_code = 'USR-0001';

insert into familycare.care_branch(care_header_id, branch_code, name, branch_type, coordinator_user_id, coordinator_name, city, description, sort_order)
select h.id, v.branch_code, v.name, v.branch_type, u.id, v.coordinator_name, v.city, v.description, v.sort_order
from familycare.care_header h
join (values
    ('CB-0001','Parintii mei','familie_seniori','Ioana Popescu','Iasi','Ramificatie pentru parintii coordonatorului.',1,'USR-0001'),
    ('CB-0002','Familia mea','familie_proprie','Ioana Popescu','Bucuresti','Ramificatie pentru familia proprie.',2,'USR-0001'),
    ('CB-0003','Parintii sotiei','familie_seniori','Andrei Ionescu','Cluj','Ramificatie pentru parintii sotiei.',3,'USR-0003'),
    ('CB-0004','Casa din Iasi','locuinta','Ioana Popescu','Iasi','Ramificatie pentru locuinta urmarita.',4,'USR-0001'),
    ('CB-0005','Masina tatalui','vehicul','Ioana Popescu','Iasi','Ramificatie pentru vehicul.',5,'USR-0001')
) as v(branch_code,name,branch_type,coordinator_name,city,description,sort_order,user_code) on true
left join familycare.app_user u on u.user_code = v.user_code
where h.header_code = 'CH-RO-0001';

insert into familycare.branch_member(care_branch_id, user_id, member_role, is_coordinator)
select b.id, u.id, 'coordinator', true
from familycare.care_branch b
join familycare.app_user u on u.user_code = case when b.branch_code = 'CB-0003' then 'USR-0003' else 'USR-0001' end;

insert into familycare.managed_entity(
    care_header_id, care_branch_id, entity_code, entity_type, display_name, gender, birth_date, phone, email,
    allows_senior_screen, country, county_or_sector, city, street, street_no, building, entrance, floor, apartment, postal_code,
    access_details, address_notes, notes
)
select h.id, b.id, v.entity_code, v.entity_type, v.display_name, v.gender, v.birth_date::date, v.phone, v.email,
       v.allows_senior_screen, 'Romania', v.county_or_sector, v.city, v.street, v.street_no, v.building, v.entrance, v.floor, v.apartment, v.postal_code,
       v.access_details, v.address_notes, v.notes
from familycare.care_header h
join (values
    ('CB-0001','ME-0001','seniora','Maria Popescu','F','1948-04-12','0700000101',null,true,'Iasi','Iasi','Strada Florilor','12','B1','A','2','10','700000','Cheie la vecina de la ap. 8','Interfon Popescu','Tratament tensiune si vizite regulate.'),
    ('CB-0002','ME-0002','copil','Ana Popescu','F','2014-09-02',null,null,false,'Bucuresti','Bucuresti','Strada Exemplu','10','C2','B','3','20','010000',null,null,'Agenda pentru familie/copil.'),
    ('CB-0003','ME-0003','senior','Ion Ionescu','M','1945-02-20','0700000103',null,true,'Cluj','Cluj-Napoca','Strada Memorandumului','2',null,null,null,null,'400000','Suna inainte de vizita',null,'Senior in ramificatia parintii sotiei.'),
    ('CB-0004','ME-0004','locuinta','Casa din Iasi',null,null,null,null,false,'Iasi','Iasi','Strada Casei','7',null,null,null,null,'700100','Poarta cu cod','Verificare centrala si facturi','Locuinta administrata de familie.'),
    ('CB-0001','ME-0005','animal','Rex',null,null,null,null,false,'Iasi','Iasi','Strada Florilor','12',null,null,null,null,'700000',null,'Hrana in debara','Animal de companie.'),
    ('CB-0005','ME-0006','vehicul','Masina tatalui',null,null,null,null,false,'Iasi','Iasi','Garaj familie','1',null,null,null,null,'700200','Cheia la Ioana','ITP si asigurare','Vehicul urmarit in agenda.')
) as v(branch_code, entity_code, entity_type, display_name, gender, birth_date, phone, email, allows_senior_screen, county_or_sector, city, street, street_no, building, entrance, floor, apartment, postal_code, access_details, address_notes, notes)
  on true
join familycare.care_branch b on b.branch_code = v.branch_code
where h.header_code = 'CH-RO-0001';

insert into familycare.care_relationship(care_header_id, from_entity_id, to_entity_id, from_user_id, relationship_type, notes)
select h.id, e.id, null, u.id, 'fiica', 'Ioana este contact principal pentru Maria.'
from familycare.care_header h
join familycare.managed_entity e on e.entity_code = 'ME-0001'
join familycare.app_user u on u.user_code = 'USR-0001'
where h.header_code = 'CH-RO-0001';

insert into familycare.doctor(doctor_code, full_name, specialty, phone, email, clinic_name, country, county_or_sector, city, street, street_no)
values
('DOC-0001','Dr. Popescu','Medicina de familie','0700000004','dr.popescu@example.com','Cabinet familie','Romania','Iasi','Iasi','Strada Cabinetului','3'),
('DOC-0002','Dr. Ionescu','Cardiologie','0700000005','dr.ionescu@example.com','Clinica Cardio','Romania','Iasi','Iasi','Strada Sanatatii','9');

insert into familycare.provider(provider_code, name, provider_type, phone, email, country, county_or_sector, city, street, street_no)
values
('PRV-0001','Farmacia Partener','farmacie','0700000006','farmacie@example.com','Romania','Iasi','Iasi','Strada Farmaciei','4'),
('PRV-0002','Catering Senior Plus','catering','0700000007','catering@example.com','Romania','Iasi','Iasi','Strada Mesei','5'),
('PRV-0003','Kinetoterapie Acasa','kinetoterapie','0700000008','kineto@example.com','Romania','Iasi','Iasi','Strada Recuperarii','11');

insert into familycare.medication(entity_id, medication_name, dose, instructions, prescribing_doctor_id)
select e.id, 'Tratament tensiune', '1 comprimat', 'Dimineata dupa masa', d.id
from familycare.managed_entity e
left join familycare.doctor d on d.doctor_code = 'DOC-0002'
where e.entity_code = 'ME-0001';

insert into familycare.doctor_recommendation(entity_id, doctor_id, recommendation_title, recommendation_text, recommendation_date, valid_until, can_generate_task)
select e.id, d.id, 'Masurare tensiune', 'Masurare tensiune zilnic dimineata si notare valoare.', current_date, current_date + interval '6 months', true
from familycare.managed_entity e
left join familycare.doctor d on d.doctor_code = 'DOC-0002'
where e.entity_code = 'ME-0001';

insert into familycare.calendar_series(care_header_id, care_branch_id, entity_id, section_key, task_type, title, description, start_date, end_date, start_time, recurrence_rule, repeat_every_days, active_weekdays, escalation_minutes, email_on_create, email_on_finish, email_recipients)
select h.id, b.id, e.id, v.section_key, v.task_type, v.title, v.description, current_date, current_date + interval '6 months', v.start_time::time, v.recurrence_rule, v.repeat_every_days, v.active_weekdays, v.escalation_minutes, v.email_on_create, v.email_on_finish, v.email_recipients
from familycare.care_header h
join familycare.care_branch b on b.branch_code = 'CB-0001'
join familycare.managed_entity e on e.entity_code = 'ME-0001'
join (values
    ('treatment','medication','Tratament tensiune','Pastila de tensiune dimineata','09:00','selected_weekdays',null,'1,2,3,4,5,6,7',30,true,true,'ioana@example.com'),
    ('agenda','visit','Vizita ingrijitor','Vizita ingrijitor la domiciliu','11:00','selected_weekdays',null,'1,3,5',60,true,true,'ioana@example.com,mihai@example.com'),
    ('recommendations','medical_check','Control cardiologie','Programare control cardiologie','18:00','every_x_days',2,'',120,true,false,'ioana@example.com')
) as v(section_key, task_type, title, description, start_time, recurrence_rule, repeat_every_days, active_weekdays, escalation_minutes, email_on_create, email_on_finish, email_recipients) on true
where h.header_code = 'CH-RO-0001';

insert into familycare.journal_entry(care_header_id, care_branch_id, entity_id, author_user_id, entry_date, mood_score, vitality_score, title, body, tags)
select h.id, b.id, e.id, u.id, current_date, 7, 8, 'Stare buna', 'A mancat bine si a confirmat tratamentul.', 'mancare,tratament'
from familycare.care_header h
join familycare.care_branch b on b.branch_code = 'CB-0001'
join familycare.managed_entity e on e.entity_code = 'ME-0001'
join familycare.app_user u on u.user_code = 'USR-0002'
where h.header_code = 'CH-RO-0001';

insert into familycare.alert_rule(care_header_id, rule_code, name, condition_text, escalation_minutes)
select h.id, 'ALR-0001', 'Tratament intarziat', 'Tratament neconfirmat dupa 30 minute', 30
from familycare.care_header h
where h.header_code = 'CH-RO-0001';

insert into familycare.alert(care_header_id, care_branch_id, entity_id, alert_rule_id, severity, title, message, status)
select h.id, b.id, e.id, r.id, 'medium', 'Tratament neconfirmat', 'Demo: tratamentul de dimineata necesita confirmare.', 'open'
from familycare.care_header h
join familycare.care_branch b on b.branch_code = 'CB-0001'
join familycare.managed_entity e on e.entity_code = 'ME-0001'
join familycare.alert_rule r on r.rule_code = 'ALR-0001'
where h.header_code = 'CH-RO-0001';

insert into familycare.mail_account(care_header_id, account_code, provider, email, read_only)
select h.id, 'MAIL-0001', 'Gmail/Outlook demo', 'familie@example.com', true
from familycare.care_header h
where h.header_code = 'CH-RO-0001';

insert into familycare.mail_message(mail_account_id, sender_email, sender_name, subject, received_at, body_preview, source_type, is_read)
select m.id, v.sender_email, v.sender_name, v.subject, now() - (v.minutes_ago || ' minutes')::interval, v.body_preview, v.source_type, false
from familycare.mail_account m
join (values
    ('doctor@example.com','Dr. Popescu','Control recomandat','Recomand control cardiologie luna aceasta si monitorizare tensiune.',90,'medic'),
    ('farmacie@example.com','Farmacia Partener','Reteta disponibila','Medicamentele sunt disponibile pentru ridicare.',45,'farmacie'),
    ('mihai@example.com','Mihai Ingrijitor','Vizita finalizata','Am finalizat vizita si tratamentul a fost confirmat.',15,'ingrijitor')
) as v(sender_email, sender_name, subject, body_preview, minutes_ago, source_type) on true
where m.account_code = 'MAIL-0001';

insert into familycare.mail_task_suggestion(mail_message_id, suggested_title, suggested_date, suggested_time, status)
select mm.id, 'Programeaza control cardiologie', current_date + 7, '10:00', 'proposed'
from familycare.mail_message mm
where mm.subject = 'Control recomandat';

insert into familycare.subscription_plan(plan_code, name, monthly_price_eur, max_entities, details)
values
('BASIC','Basic',5,1,'Calendar si jurnal pentru o entitate'),
('FAMILY_PLUS','Family Plus',10,3,'Alerte, email si istoric'),
('PREMIUM','Premium',20,10,'Mai multe ramificatii si entitati');

-- =========================================================
-- Configuration records used by the UI Configurari page
-- =========================================================
insert into familycare.config_record(section_key, payload, sort_order)
values
('care-header', jsonb_build_object('ID','CH-RO-0001','Denumire','Reteaua Popescu','Tip context','Familie proprie','Coordonator','Ioana Popescu','Oras','Iasi','Detalii','Header principal pentru ramificatii si entitati.'), 1),
('care-headers', jsonb_build_object('ID','CH-RO-0001','Denumire','Reteaua Popescu','Tip context','Familie proprie','Coordonator','Ioana Popescu','Oras','Iasi','Detalii','Header principal pentru ramificatii si entitati.'), 1),
('branches', jsonb_build_object('Cod','CB-0001','Ramificatie','Parintii mei','Tip context','Familie seniori','Oras','Iasi','Coordonator','Ioana Popescu'), 1),
('branches', jsonb_build_object('Cod','CB-0002','Ramificatie','Familia mea','Tip context','Familie proprie','Oras','Bucuresti','Coordonator','Ioana Popescu'), 2),
('branches', jsonb_build_object('Cod','CB-0003','Ramificatie','Parintii sotiei','Tip context','Familie seniori','Oras','Cluj','Coordonator','Andrei Ionescu'), 3),
('managed-entities', jsonb_build_object('Cod','ME-0001','Denumire','Maria Popescu','Tip','seniora','Ramificatie','Parintii mei','Oras','Iasi','Ecran senior','da'), 1),
('managed-entities', jsonb_build_object('Cod','ME-0002','Denumire','Ana Popescu','Tip','copil','Ramificatie','Familia mea','Oras','Bucuresti','Ecran senior','nu'), 2),
('managed-entities', jsonb_build_object('Cod','ME-0004','Denumire','Casa din Iasi','Tip','locuinta','Ramificatie','Casa din Iasi','Oras','Iasi','Ecran senior','nu'), 3),
('managed-entities', jsonb_build_object('Cod','ME-0005','Denumire','Rex','Tip','animal','Ramificatie','Parintii mei','Oras','Iasi','Ecran senior','nu'), 4),
('entity-types', jsonb_build_object('Tip','senior','Descriere','Persoana varstnica - permite ecran cu butoane mari'), 1),
('entity-types', jsonb_build_object('Tip','seniora','Descriere','Persoana varstnica - permite ecran cu butoane mari'), 2),
('entity-types', jsonb_build_object('Tip','copil','Descriere','Copil / beneficiar'), 3),
('entity-types', jsonb_build_object('Tip','locuinta','Descriere','Casa, apartament sau proprietate'), 4),
('entity-types', jsonb_build_object('Tip','animal','Descriere','Animal de companie'), 5),
('entity-types', jsonb_build_object('Tip','vehicul','Descriere','Masina sau alt vehicul'), 6),
('users', jsonb_build_object('Nume','Ioana Popescu','Email','ioana@example.com','Rol','coordinator','Domiciliu','Bucuresti'), 1),
('users', jsonb_build_object('Nume','Mihai Ingrijitor','Email','mihai@example.com','Rol','ingrijitor','Domiciliu','Iasi'), 2),
('doctors', jsonb_build_object('Nume medic','Dr. Popescu','Specialitate','Medicina de familie','Telefon','0700000004','Email','dr.popescu@example.com'), 1),
('providers', jsonb_build_object('Denumire','Farmacia Partener','Tip furnizor','Farmacie','Telefon','0700000006','Email','farmacie@example.com'), 1),
('task-types', jsonb_build_object('Denumire','Tratament','Categorie','medical administrativ','Recurent','da','Detalii','confirmare pastila'), 1),
('task-types', jsonb_build_object('Denumire','Vizita','Categorie','ingrijire','Recurent','da','Detalii','vizita ingrijitor/familie'), 2),
('alert-rules', jsonb_build_object('Denumire','Tratament intarziat','Conditie','neconfirmat dupa 30 minute','Escaladare','familie'), 1),
('notification-channels', jsonb_build_object('Canal','Email','Tip','outbound','Activ','da','Detalii','notificari la taskuri'), 1),
('notification-channels', jsonb_build_object('Canal','Telefon','Tip','apel/SMS','Activ','viitor','Detalii','pentru seniori fara tableta'), 2),
('subscription-plans', jsonb_build_object('Plan','Basic','Pret','5 EUR','Limita persoane','1','Detalii','calendar + jurnal'), 1),
('subscription-plans', jsonb_build_object('Plan','Family Plus','Pret','10 EUR','Limita persoane','3','Detalii','alerte + email + istoric'), 2),
('info', jsonb_build_object('Cheie','Produs','Valoare','FamilyCare','Categorie','aplicatie','Detalii','Agenda inteligenta de familie pentru persoane si alte entitati.'), 1);

-- =========================================================
-- Useful views for dashboard/demo checks
-- =========================================================
create view familycare.v_dashboard_entities as
select
    h.header_code,
    h.name as header_name,
    b.branch_code,
    b.name as branch_name,
    e.entity_code,
    e.display_name,
    e.entity_type,
    e.city,
    e.allows_senior_screen,
    e.active
from familycare.care_header h
left join familycare.care_branch b on b.care_header_id = h.id
left join familycare.managed_entity e on e.care_branch_id = b.id
order by h.id, b.sort_order, e.id;

create view familycare.v_config_counts as
select section_key, count(*) as total
from familycare.config_record
group by section_key;

commit;

-- =========================================================
-- Verification after running
-- =========================================================
select 'care_header' as table_name, count(*) as total from familycare.care_header
union all select 'care_branch', count(*) from familycare.care_branch
union all select 'managed_entity', count(*) from familycare.managed_entity
union all select 'calendar_series', count(*) from familycare.calendar_series
union all select 'journal_entry', count(*) from familycare.journal_entry
union all select 'alert', count(*) from familycare.alert
union all select 'mail_message', count(*) from familycare.mail_message
union all select 'config_record', count(*) from familycare.config_record
order by table_name;

select * from familycare.v_config_counts order by section_key;


-- V1.0.25 bundled reset/refresh

-- FamilyCare V1.0.23 - refresh Configurari demo data
-- Database: Caremyla
-- Schema: familycare
-- Purpose: repopulate Configurari with payload keys exactly matching the application UI.
-- This script does NOT drop the schema and does NOT delete operational data.

begin;

create schema if not exists familycare;

create table if not exists familycare.config_record (
    id bigserial primary key,
    section_key varchar(80) not null,
    payload jsonb not null default '{}'::jsonb,
    sort_order int not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

-- Clear only the configuration demo records used by the Configurari page.
delete from familycare.config_record;

insert into familycare.config_record(section_key, payload, sort_order)
values
-- Care Header
('care-header', jsonb_build_object(
    'Denumire','Rețeaua Popescu',
    'Tip context','Familie proprie',
    'Coordonator','Ioana Popescu',
    'Detalii','Header principal CH-RO-0001 pentru ramificații, entități urmărite și membri ai familiei.'
), 1),

-- Ramificatii
('branches', jsonb_build_object(
    'Denumire ramificație','Părinții mei',
    'Tip','Familie seniori',
    'Oraș','Iași',
    'Coordonator','Ioana Popescu'
), 1),
('branches', jsonb_build_object(
    'Denumire ramificație','Familia mea',
    'Tip','Familie proprie',
    'Oraș','București',
    'Coordonator','Ioana Popescu'
), 2),
('branches', jsonb_build_object(
    'Denumire ramificație','Părinții soției',
    'Tip','Familie seniori',
    'Oraș','Cluj-Napoca',
    'Coordonator','Andrei Ionescu'
), 3),
('branches', jsonb_build_object(
    'Denumire ramificație','Casa din Iași',
    'Tip','Locuință',
    'Oraș','Iași',
    'Coordonator','Ioana Popescu'
), 4),
('branches', jsonb_build_object(
    'Denumire ramificație','Mașina tatălui',
    'Tip','Vehicul',
    'Oraș','Iași',
    'Coordonator','Ioana Popescu'
), 5),

-- Entitati urmarite / persoane / alte contexte
('care-persons', jsonb_build_object(
    'Denumire','Maria Popescu',
    'Tip entitate','senioră',
    'Ramificație','Părinții mei',
    'Adresă / detalii','România, Iași, Strada Florilor nr. 12, bloc B1, scara A, etaj 2, ap. 10. Cheie la vecina de la ap. 8.',
    'Responsabil','Ioana Popescu'
), 1),
('care-persons', jsonb_build_object(
    'Denumire','Ion Popescu',
    'Tip entitate','senior',
    'Ramificație','Părinții mei',
    'Adresă / detalii','România, Iași, Strada Florilor nr. 12. Necesită confirmare tratament și vizite.',
    'Responsabil','Ioana Popescu'
), 2),
('care-persons', jsonb_build_object(
    'Denumire','Ana Popescu',
    'Tip entitate','copil',
    'Ramificație','Familia mea',
    'Adresă / detalii','România, București, Strada Exemplu nr. 10, bloc C2, scara B, etaj 3, ap. 20.',
    'Responsabil','Ioana Popescu'
), 3),
('care-persons', jsonb_build_object(
    'Denumire','Casa din Iași',
    'Tip entitate','locuință',
    'Ramificație','Casa din Iași',
    'Adresă / detalii','România, Iași, Strada Casei nr. 7. Verificare centrală, facturi, acces și lucrări.',
    'Responsabil','Ioana Popescu'
), 4),
('care-persons', jsonb_build_object(
    'Denumire','Rex',
    'Tip entitate','animal',
    'Ramificație','Părinții mei',
    'Adresă / detalii','Locuiește cu Maria Popescu. Hrană în debara, vizită veterinară periodică.',
    'Responsabil','Mihai Îngrijitor'
), 5),
('care-persons', jsonb_build_object(
    'Denumire','Mașina tatălui',
    'Tip entitate','vehicul',
    'Ramificație','Mașina tatălui',
    'Adresă / detalii','Garaj familie Iași. Urmărește ITP, RCA, revizie, schimb anvelope.',
    'Responsabil','Ioana Popescu'
), 6),

-- Tipuri entitate
('entity-types', jsonb_build_object(
    'Tip entitate','senior',
    'Categorie','persoană',
    'Are domiciliu/adresă','da',
    'Interfață dedicată','ecran cu butoane mari',
    'Detalii','Persoană vârstnică. Poate avea tratament, vizite, jurnal și buton de ajutor.'
), 1),
('entity-types', jsonb_build_object(
    'Tip entitate','senioră',
    'Categorie','persoană',
    'Are domiciliu/adresă','da',
    'Interfață dedicată','ecran cu butoane mari',
    'Detalii','Persoană vârstnică. Poate avea tratament, vizite, jurnal și buton de ajutor.'
), 2),
('entity-types', jsonb_build_object(
    'Tip entitate','copil',
    'Categorie','persoană',
    'Are domiciliu/adresă','da',
    'Interfață dedicată','agenda simplă',
    'Detalii','Pentru program, activități, școală, medic, notificări și responsabilități.'
), 3),
('entity-types', jsonb_build_object(
    'Tip entitate','locuință',
    'Categorie','bun / proprietate',
    'Are domiciliu/adresă','da',
    'Interfață dedicată','agenda locuință',
    'Detalii','Pentru facturi, mentenanță, verificări, contracte și acces.'
), 4),
('entity-types', jsonb_build_object(
    'Tip entitate','animal',
    'Categorie','animal de companie',
    'Are domiciliu/adresă','da',
    'Interfață dedicată','agenda animal',
    'Detalii','Pentru hrană, tratamente, veterinar și plimbări.'
), 5),
('entity-types', jsonb_build_object(
    'Tip entitate','vehicul',
    'Categorie','bun mobil',
    'Are domiciliu/adresă','nu',
    'Interfață dedicată','agenda vehicul',
    'Detalii','Pentru ITP, RCA, revizie, rovinietă, service și documente.'
), 6),

-- Arbore genealogic
('family-tree', jsonb_build_object(
    'Persoană 1','Ioana Popescu',
    'Relație','fiică',
    'Persoană 2','Maria Popescu',
    'Observații','Ioana este contact principal și coordonator pentru ramificația Părinții mei.'
), 1),
('family-tree', jsonb_build_object(
    'Persoană 1','Ana Popescu',
    'Relație','copil',
    'Persoană 2','Ioana Popescu',
    'Observații','Ana aparține ramificației Familia mea.'
), 2),
('family-tree', jsonb_build_object(
    'Persoană 1','Andrei Ionescu',
    'Relație','ginere / coordonator',
    'Persoană 2','Ion Ionescu',
    'Observații','Andrei coordonează ramificația Părinții soției.'
), 3),

-- Utilizatori
('users', jsonb_build_object(
    'Nume','Ioana Popescu',
    'Email','ioana@example.com',
    'Rol','coordonator familie',
    'Domiciliu complet','România, București, Strada Exemplu nr. 10, bloc C2, scara B, etaj 3, ap. 20'
), 1),
('users', jsonb_build_object(
    'Nume','Mihai Îngrijitor',
    'Email','mihai@example.com',
    'Rol','îngrijitor',
    'Domiciliu complet','România, Iași, Strada Păcii nr. 5'
), 2),
('users', jsonb_build_object(
    'Nume','Andrei Ionescu',
    'Email','andrei@example.com',
    'Rol','membru familie',
    'Domiciliu complet','România, Cluj-Napoca, Strada Memorandumului nr. 2'
), 3),

-- Medici
('doctors', jsonb_build_object(
    'Nume medic','Dr. Popescu',
    'Specialitate','Medicină de familie',
    'Telefon','0700000004',
    'Domiciliu/cabinet','Cabinet familie, Iași, Strada Cabinetului nr. 3'
), 1),
('doctors', jsonb_build_object(
    'Nume medic','Dr. Ionescu',
    'Specialitate','Cardiologie',
    'Telefon','0700000005',
    'Domiciliu/cabinet','Clinica Cardio, Iași, Strada Sănătății nr. 9'
), 2),

-- Furnizori
('providers', jsonb_build_object(
    'Denumire','Farmacia Partener',
    'Tip furnizor','Farmacie',
    'Telefon','0700000006',
    'Adresă completă','România, Iași, Strada Farmaciei nr. 4'
), 1),
('providers', jsonb_build_object(
    'Denumire','Catering Senior Plus',
    'Tip furnizor','Catering',
    'Telefon','0700000007',
    'Adresă completă','România, Iași, Strada Mesei nr. 5'
), 2),
('providers', jsonb_build_object(
    'Denumire','Kinetoterapie Acasă',
    'Tip furnizor','Kinetoterapie',
    'Telefon','0700000008',
    'Adresă completă','România, Iași, Strada Recuperării nr. 11'
), 3),

-- Tipuri task
('task-types', jsonb_build_object(
    'Denumire','Tratament',
    'Categorie','medical administrativ',
    'Recurent','da',
    'Detalii','Alarmă, confirmare administrare, escaladare către familie dacă nu este confirmat.'
), 1),
('task-types', jsonb_build_object(
    'Denumire','Vizită',
    'Categorie','îngrijire',
    'Recurent','da',
    'Detalii','Vizită îngrijitor/familie, cu confirmare finalizare și notă în jurnal.'
), 2),
('task-types', jsonb_build_object(
    'Denumire','Cumpărături',
    'Categorie','logistică',
    'Recurent','opțional',
    'Detalii','Listă cumpărături, responsabil și notificare la finalizare.'
), 3),
('task-types', jsonb_build_object(
    'Denumire','Mentenanță locuință',
    'Categorie','locuință',
    'Recurent','da',
    'Detalii','Facturi, verificări tehnice, revizii, reparații.'
), 4),
('task-types', jsonb_build_object(
    'Denumire','Revizie vehicul',
    'Categorie','vehicul',
    'Recurent','da',
    'Detalii','ITP, RCA, service, anvelope, rovinietă.'
), 5),

-- Reguli alerte
('alert-rules', jsonb_build_object(
    'Denumire','Tratament întârziat',
    'Condiție','Tratament neconfirmat după 30 minute',
    'Escaladare','Notifică familia',
    'Canal','Email / SMS / push'
), 1),
('alert-rules', jsonb_build_object(
    'Denumire','Vizită nefinalizată',
    'Condiție','Vizita nu este confirmată până la ora limită',
    'Escaladare','Notifică coordonatorul ramificației',
    'Canal','Email / push'
), 2),
('alert-rules', jsonb_build_object(
    'Denumire','Mesaj de ajutor',
    'Condiție','Persoana apasă butonul Am nevoie de ajutor',
    'Escaladare','Alertă imediată către contactele principale',
    'Canal','Telefon / SMS / push'
), 3),

-- Canale notificare
('notification-channels', jsonb_build_object(
    'Canal','Email',
    'Tip','outbound',
    'Activ','da',
    'Detalii','Trimite notificări la adăugare task, finalizare task și escaladare.'
), 1),
('notification-channels', jsonb_build_object(
    'Canal','Telefon / SMS',
    'Tip','apel / SMS',
    'Activ','viitor',
    'Detalii','Util pentru seniori fără tabletă sau fără aplicație.'
), 2),
('notification-channels', jsonb_build_object(
    'Canal','Mail Center',
    'Tip','read-only inbox',
    'Activ','demo',
    'Detalii','Preluare emailuri de la medic, farmacie, îngrijitor sau furnizor.'
), 3),

-- Planuri abonament
('subscription-plans', jsonb_build_object(
    'Plan','Basic',
    'Preț','5 EUR / lună',
    'Limită persoane','1 entitate',
    'Detalii','Calendar, jurnal și notificări simple.'
), 1),
('subscription-plans', jsonb_build_object(
    'Plan','Family Plus',
    'Preț','10 EUR / lună',
    'Limită persoane','3 entități',
    'Detalii','Alerte, email, istoric, mai mulți membri familie.'
), 2),
('subscription-plans', jsonb_build_object(
    'Plan','Premium',
    'Preț','20 EUR / lună',
    'Limită persoane','10 entități',
    'Detalii','Mai multe ramificații, furnizori, rapoarte și prioritizare.'
), 3),

-- Informatii
('info', jsonb_build_object(
    'Cheie','Produs',
    'Valoare','FamilyCare',
    'Categorie','aplicație',
    'Detalii','Agendă inteligentă de familie pentru persoane, locuințe, animale, vehicule și alte responsabilități recurente.'
), 1),
('info', jsonb_build_object(
    'Cheie','Producător',
    'Valoare','Cademix',
    'Categorie','companie',
    'Detalii','FamilyCare by Cademix.'
), 2),
('info', jsonb_build_object(
    'Cheie','Bază date',
    'Valoare','Caremyla / schema familycare',
    'Categorie','tehnic',
    'Detalii','Datele de configurare sunt administrate central.'
), 3);

commit;

select section_key, count(*) as total
from familycare.config_record
group by section_key
order by section_key;
