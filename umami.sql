--
-- PostgreSQL database dump
--

-- Dumped from database version 17.5 (Debian 17.5-1.pgdg110+1)
-- Dumped by pg_dump version 17.2

-- Started on 2025-07-09 13:53:55 +03

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


--
-- TOC entry 330 (class 1255 OID 26631)
-- Name: _qd_dump_stats(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public._qd_dump_stats(include_sensitive_info boolean) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $_$
SELECT
  json_agg(t)
  FROM (
    SELECT
  c.table_name as "tableName",
  c.table_schema as "schemaName",
  cl.reltuples,
  cl.relpages,
  cl.relallvisible,
  n.nspname as "schemaName",
  json_agg(
    json_build_object(
      'columnName', c.column_name,
      'dataType', c.data_type,
      'isNullable', (c.is_nullable = 'YES')::boolean,
      'characterMaximumLength', c.character_maximum_length,
      'numericPrecision', c.numeric_precision,
      'numericScale', c.numeric_scale,
      'columnDefault', c.column_default,
      'stats', (
        select json_build_object(
          'stainherit', s.stainherit,
          'stanullfrac', s.stanullfrac,
          'stawidth', s.stawidth,
          'stadistinct', s.stadistinct,
          -- slot 1
          'stakind1', s.stakind1,
          'staop1', s.staop1,
          'stacoll1', s.stacoll1,
          'stanumbers1', s.stanumbers1,
          -- slot 2
          'stakind2', s.stakind2,
          'staop2', s.staop2,
          'stacoll2', s.stacoll2,
          'stanumbers2', s.stanumbers2,
          -- slot 3
          'stakind3', s.stakind3,
          'staop3', s.staop3,
          'stacoll3', s.stacoll3,
          'stanumbers3', s.stanumbers3,
          -- slot 4
          'stakind4', s.stakind4,
          'staop4', s.staop4,
          'stacoll4', s.stacoll4,
          'stanumbers4', s.stanumbers4,
          -- slot 5
          'stakind5', s.stakind5,
          'staop5', s.staop5,
          'stacoll5', s.stacoll5,
          'stanumbers5', s.stanumbers5,
          -- non-anonymous stats
          'stavalues1', case when $1 then s.stavalues1 else null end,
          'stavalues2', case when $1 then s.stavalues2 else null end,
          'stavalues3', case when $1 then s.stavalues3 else null end,
          'stavalues4', case when $1 then s.stavalues4 else null end,
          'stavalues5', case when $1 then s.stavalues5 else null end
        )
          from pg_statistic s
        where
          s.starelid = a.attrelid
          and s.staattnum = a.attnum
      )
    )
  ORDER BY c.ordinal_position) as columns
FROM
    information_schema.columns c
JOIN
    pg_attribute a
    ON a.attrelid = (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass
    AND a.attname = c.column_name
JOIN
    pg_class cl
    ON cl.relname = c.table_name
JOIN
    pg_namespace n
    ON n.oid = cl.relnamespace
WHERE
    c.table_name not like 'pg_%'
    and n.nspname <> 'information_schema'
    and c.table_name not in ('pg_stat_statements', 'pg_stat_statements_info')
GROUP BY
    c.table_name, c.table_schema, cl.reltuples, cl.relpages, cl.relallvisible, n.nspname /* @qd_introspection */
) t;
$_$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 284 (class 1259 OID 17301)
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


--
-- TOC entry 289 (class 1259 OID 17376)
-- Name: event_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.event_data (
    event_data_id uuid NOT NULL,
    website_id uuid NOT NULL,
    website_event_id uuid NOT NULL,
    data_key character varying(500) NOT NULL,
    string_value character varying(500),
    number_value numeric(19,4),
    date_value timestamp(6) with time zone,
    data_type integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- TOC entry 293 (class 1259 OID 17438)
-- Name: report; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report (
    report_id uuid NOT NULL,
    user_id uuid NOT NULL,
    website_id uuid NOT NULL,
    type character varying(200) NOT NULL,
    name character varying(200) NOT NULL,
    description character varying(500) NOT NULL,
    parameters character varying(6000) NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) with time zone
);


--
-- TOC entry 286 (class 1259 OID 17353)
-- Name: session; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session (
    session_id uuid NOT NULL,
    website_id uuid NOT NULL,
    browser character varying(20),
    os character varying(20),
    device character varying(20),
    screen character varying(11),
    language character varying(35),
    country character(2),
    region character varying(20),
    city character varying(50),
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    distinct_id character varying(50)
);


--
-- TOC entry 292 (class 1259 OID 17429)
-- Name: session_data; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.session_data (
    session_data_id uuid NOT NULL,
    website_id uuid NOT NULL,
    session_id uuid NOT NULL,
    data_key character varying(500) NOT NULL,
    string_value character varying(500),
    number_value numeric(19,4),
    date_value timestamp(6) with time zone,
    data_type integer NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    distinct_id character varying(50)
);


--
-- TOC entry 290 (class 1259 OID 17384)
-- Name: team; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team (
    team_id uuid NOT NULL,
    name character varying(50) NOT NULL,
    access_code character varying(50),
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) with time zone,
    deleted_at timestamp(6) with time zone,
    logo_url character varying(2183)
);


--
-- TOC entry 291 (class 1259 OID 17390)
-- Name: team_user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.team_user (
    team_user_id uuid NOT NULL,
    team_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role character varying(50) NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) with time zone
);


--
-- TOC entry 285 (class 1259 OID 17347)
-- Name: user; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public."user" (
    user_id uuid NOT NULL,
    username character varying(255) NOT NULL,
    password character varying(60) NOT NULL,
    role character varying(50) NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) with time zone,
    deleted_at timestamp(6) with time zone,
    display_name character varying(255),
    logo_url character varying(2183)
);


--
-- TOC entry 287 (class 1259 OID 17359)
-- Name: website; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website (
    website_id uuid NOT NULL,
    name character varying(100) NOT NULL,
    domain character varying(500),
    share_id character varying(50),
    reset_at timestamp(6) with time zone,
    user_id uuid,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp(6) with time zone,
    deleted_at timestamp(6) with time zone,
    created_by uuid,
    team_id uuid
);


--
-- TOC entry 288 (class 1259 OID 17367)
-- Name: website_event; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.website_event (
    event_id uuid NOT NULL,
    website_id uuid NOT NULL,
    session_id uuid NOT NULL,
    created_at timestamp(6) with time zone DEFAULT CURRENT_TIMESTAMP,
    url_path character varying(500) NOT NULL,
    url_query character varying(500),
    referrer_path character varying(500),
    referrer_query character varying(500),
    referrer_domain character varying(500),
    page_title character varying(500),
    event_type integer DEFAULT 1 NOT NULL,
    event_name character varying(50),
    visit_id uuid NOT NULL,
    tag character varying(50),
    fbclid character varying(255),
    gclid character varying(255),
    li_fat_id character varying(255),
    msclkid character varying(255),
    ttclid character varying(255),
    twclid character varying(255),
    utm_campaign character varying(255),
    utm_content character varying(255),
    utm_medium character varying(255),
    utm_source character varying(255),
    utm_term character varying(255),
    hostname character varying(100)
);


--
-- TOC entry 3733 (class 2606 OID 17309)
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- TOC entry 3779 (class 2606 OID 17383)
-- Name: event_data event_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.event_data
    ADD CONSTRAINT event_data_pkey PRIMARY KEY (event_data_id);


--
-- TOC entry 3803 (class 2606 OID 17445)
-- Name: report report_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report
    ADD CONSTRAINT report_pkey PRIMARY KEY (report_id);


--
-- TOC entry 3796 (class 2606 OID 17437)
-- Name: session_data session_data_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session_data
    ADD CONSTRAINT session_data_pkey PRIMARY KEY (session_data_id);


--
-- TOC entry 3740 (class 2606 OID 17358)
-- Name: session session_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (session_id);


--
-- TOC entry 3787 (class 2606 OID 17389)
-- Name: team team_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team
    ADD CONSTRAINT team_pkey PRIMARY KEY (team_id);


--
-- TOC entry 3790 (class 2606 OID 17395)
-- Name: team_user team_user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.team_user
    ADD CONSTRAINT team_user_pkey PRIMARY KEY (team_user_id);


--
-- TOC entry 3735 (class 2606 OID 17352)
-- Name: user user_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (user_id);


--
-- TOC entry 3763 (class 2606 OID 17375)
-- Name: website_event website_event_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website_event
    ADD CONSTRAINT website_event_pkey PRIMARY KEY (event_id);


--
-- TOC entry 3755 (class 2606 OID 17366)
-- Name: website website_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.website
    ADD CONSTRAINT website_pkey PRIMARY KEY (website_id);


--
-- TOC entry 3777 (class 1259 OID 17417)
-- Name: event_data_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_data_created_at_idx ON public.event_data USING btree (created_at);


--
-- TOC entry 3780 (class 1259 OID 17419)
-- Name: event_data_website_event_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_data_website_event_id_idx ON public.event_data USING btree (website_event_id);


--
-- TOC entry 3781 (class 1259 OID 17479)
-- Name: event_data_website_id_created_at_data_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_data_website_id_created_at_data_key_idx ON public.event_data USING btree (website_id, created_at, data_key);


--
-- TOC entry 3782 (class 1259 OID 17454)
-- Name: event_data_website_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_data_website_id_created_at_idx ON public.event_data USING btree (website_id, created_at);


--
-- TOC entry 3783 (class 1259 OID 17418)
-- Name: event_data_website_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX event_data_website_id_idx ON public.event_data USING btree (website_id);


--
-- TOC entry 3801 (class 1259 OID 17453)
-- Name: report_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_name_idx ON public.report USING btree (name);


--
-- TOC entry 3804 (class 1259 OID 17449)
-- Name: report_report_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX report_report_id_key ON public.report USING btree (report_id);


--
-- TOC entry 3805 (class 1259 OID 17452)
-- Name: report_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_type_idx ON public.report USING btree (type);


--
-- TOC entry 3806 (class 1259 OID 17450)
-- Name: report_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_user_id_idx ON public.report USING btree (user_id);


--
-- TOC entry 3807 (class 1259 OID 17451)
-- Name: report_website_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX report_website_id_idx ON public.report USING btree (website_id);


--
-- TOC entry 3738 (class 1259 OID 17405)
-- Name: session_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_created_at_idx ON public.session USING btree (created_at);


--
-- TOC entry 3794 (class 1259 OID 17446)
-- Name: session_data_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_data_created_at_idx ON public.session_data USING btree (created_at);


--
-- TOC entry 3797 (class 1259 OID 17480)
-- Name: session_data_session_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_data_session_id_created_at_idx ON public.session_data USING btree (session_id, created_at);


--
-- TOC entry 3798 (class 1259 OID 17448)
-- Name: session_data_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_data_session_id_idx ON public.session_data USING btree (session_id);


--
-- TOC entry 3799 (class 1259 OID 17481)
-- Name: session_data_website_id_created_at_data_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_data_website_id_created_at_data_key_idx ON public.session_data USING btree (website_id, created_at, data_key);


--
-- TOC entry 3800 (class 1259 OID 17447)
-- Name: session_data_website_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_data_website_id_idx ON public.session_data USING btree (website_id);


--
-- TOC entry 3741 (class 1259 OID 17404)
-- Name: session_session_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX session_session_id_key ON public.session USING btree (session_id);


--
-- TOC entry 3742 (class 1259 OID 17458)
-- Name: session_website_id_created_at_browser_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_browser_idx ON public.session USING btree (website_id, created_at, browser);


--
-- TOC entry 3743 (class 1259 OID 17465)
-- Name: session_website_id_created_at_city_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_city_idx ON public.session USING btree (website_id, created_at, city);


--
-- TOC entry 3744 (class 1259 OID 17463)
-- Name: session_website_id_created_at_country_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_country_idx ON public.session USING btree (website_id, created_at, country);


--
-- TOC entry 3745 (class 1259 OID 17460)
-- Name: session_website_id_created_at_device_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_device_idx ON public.session USING btree (website_id, created_at, device);


--
-- TOC entry 3746 (class 1259 OID 17456)
-- Name: session_website_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_idx ON public.session USING btree (website_id, created_at);


--
-- TOC entry 3747 (class 1259 OID 17462)
-- Name: session_website_id_created_at_language_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_language_idx ON public.session USING btree (website_id, created_at, language);


--
-- TOC entry 3748 (class 1259 OID 17459)
-- Name: session_website_id_created_at_os_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_os_idx ON public.session USING btree (website_id, created_at, os);


--
-- TOC entry 3749 (class 1259 OID 26618)
-- Name: session_website_id_created_at_region_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_region_idx ON public.session USING btree (website_id, created_at, region);


--
-- TOC entry 3750 (class 1259 OID 17461)
-- Name: session_website_id_created_at_screen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_created_at_screen_idx ON public.session USING btree (website_id, created_at, screen);


--
-- TOC entry 3751 (class 1259 OID 17406)
-- Name: session_website_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX session_website_id_idx ON public.session USING btree (website_id);


--
-- TOC entry 3784 (class 1259 OID 17422)
-- Name: team_access_code_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_access_code_idx ON public.team USING btree (access_code);


--
-- TOC entry 3785 (class 1259 OID 17421)
-- Name: team_access_code_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_access_code_key ON public.team USING btree (access_code);


--
-- TOC entry 3788 (class 1259 OID 17420)
-- Name: team_team_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_team_id_key ON public.team USING btree (team_id);


--
-- TOC entry 3791 (class 1259 OID 17424)
-- Name: team_user_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_user_team_id_idx ON public.team_user USING btree (team_id);


--
-- TOC entry 3792 (class 1259 OID 17423)
-- Name: team_user_team_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX team_user_team_user_id_key ON public.team_user USING btree (team_user_id);


--
-- TOC entry 3793 (class 1259 OID 17425)
-- Name: team_user_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX team_user_user_id_idx ON public.team_user USING btree (user_id);


--
-- TOC entry 3736 (class 1259 OID 17402)
-- Name: user_user_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_user_id_key ON public."user" USING btree (user_id);


--
-- TOC entry 3737 (class 1259 OID 17403)
-- Name: user_username_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX user_username_key ON public."user" USING btree (username);


--
-- TOC entry 3752 (class 1259 OID 17410)
-- Name: website_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_created_at_idx ON public.website USING btree (created_at);


--
-- TOC entry 3753 (class 1259 OID 17476)
-- Name: website_created_by_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_created_by_idx ON public.website USING btree (created_by);


--
-- TOC entry 3761 (class 1259 OID 17412)
-- Name: website_event_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_created_at_idx ON public.website_event USING btree (created_at);


--
-- TOC entry 3764 (class 1259 OID 17413)
-- Name: website_event_session_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_session_id_idx ON public.website_event USING btree (session_id);


--
-- TOC entry 3765 (class 1259 OID 17477)
-- Name: website_event_visit_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_visit_id_idx ON public.website_event USING btree (visit_id);


--
-- TOC entry 3766 (class 1259 OID 17470)
-- Name: website_event_website_id_created_at_event_name_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_event_name_idx ON public.website_event USING btree (website_id, created_at, event_name);


--
-- TOC entry 3767 (class 1259 OID 26617)
-- Name: website_event_website_id_created_at_hostname_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_hostname_idx ON public.website_event USING btree (website_id, created_at, hostname);


--
-- TOC entry 3768 (class 1259 OID 17415)
-- Name: website_event_website_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_idx ON public.website_event USING btree (website_id, created_at);


--
-- TOC entry 3769 (class 1259 OID 17469)
-- Name: website_event_website_id_created_at_page_title_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_page_title_idx ON public.website_event USING btree (website_id, created_at, page_title);


--
-- TOC entry 3770 (class 1259 OID 17468)
-- Name: website_event_website_id_created_at_referrer_domain_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_referrer_domain_idx ON public.website_event USING btree (website_id, created_at, referrer_domain);


--
-- TOC entry 3771 (class 1259 OID 17482)
-- Name: website_event_website_id_created_at_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_tag_idx ON public.website_event USING btree (website_id, created_at, tag);


--
-- TOC entry 3772 (class 1259 OID 17466)
-- Name: website_event_website_id_created_at_url_path_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_url_path_idx ON public.website_event USING btree (website_id, created_at, url_path);


--
-- TOC entry 3773 (class 1259 OID 17467)
-- Name: website_event_website_id_created_at_url_query_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_created_at_url_query_idx ON public.website_event USING btree (website_id, created_at, url_query);


--
-- TOC entry 3774 (class 1259 OID 17414)
-- Name: website_event_website_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_idx ON public.website_event USING btree (website_id);


--
-- TOC entry 3775 (class 1259 OID 17416)
-- Name: website_event_website_id_session_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_session_id_created_at_idx ON public.website_event USING btree (website_id, session_id, created_at);


--
-- TOC entry 3776 (class 1259 OID 17478)
-- Name: website_event_website_id_visit_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_event_website_id_visit_id_created_at_idx ON public.website_event USING btree (website_id, visit_id, created_at);


--
-- TOC entry 3756 (class 1259 OID 17411)
-- Name: website_share_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_share_id_idx ON public.website USING btree (share_id);


--
-- TOC entry 3757 (class 1259 OID 17408)
-- Name: website_share_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX website_share_id_key ON public.website USING btree (share_id);


--
-- TOC entry 3758 (class 1259 OID 17475)
-- Name: website_team_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_team_id_idx ON public.website USING btree (team_id);


--
-- TOC entry 3759 (class 1259 OID 17409)
-- Name: website_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX website_user_id_idx ON public.website USING btree (user_id);


--
-- TOC entry 3760 (class 1259 OID 17407)
-- Name: website_website_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX website_website_id_key ON public.website USING btree (website_id);


-- Completed on 2025-07-09 13:54:02 +03

--
-- PostgreSQL database dump complete
--

-- Generate UUIDs for consistency (replace with actual UUID generation in your environment if needed)
-- For demonstration purposes, we'll use static UUIDs here.

-- Users
INSERT INTO public."user" (user_id, username, password, role, display_name, logo_url) VALUES
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'admin@example.com', '$2a$10$abcdefghijklmnopqrstuvwxyzabcdefghijkl', 'admin', 'Admin User', 'https://placehold.co/100x100/000000/FFFFFF?text=AU'),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'john.doe@example.com', '$2a$10$abcdefghijklmnopqrstuvwxyzabcdefghijkl', 'user', 'John Doe', 'https://placehold.co/100x100/000000/FFFFFF?text=JD'),
('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 'jane.smith@example.com', '$2a$10$abcdefghijklmnopqrstuvwxyzabcdefghijkl', 'user', 'Jane Smith', 'https://placehold.co/100x100/000000/FFFFFF?text=JS');

-- Teams
INSERT INTO public.team (team_id, name, access_code, logo_url) VALUES
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21', 'Marketing Team', 'MARKET2024', 'https://placehold.co/100x100/000000/FFFFFF?text=MT'),
('b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'Dev Team', 'DEVTEAMX', 'https://placehold.co/100x100/000000/FFFFFF?text=DT');

-- Team Users
INSERT INTO public.team_user (team_user_id, team_id, user_id, role) VALUES
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a31', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'owner'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a32', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'member'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a33', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'owner'),
('c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a34', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 'member');

-- Websites
INSERT INTO public.website (website_id, name, domain, share_id, user_id, created_by, team_id) VALUES
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'Analytics Demo Site', 'demo.example.com', 'DEMO123', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a21'),
('d0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'Product Launch Page', 'launch.example.com', 'LAUNCH456', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a22');

-- Sessions
INSERT INTO public.session (session_id, website_id, browser, os, device, screen, language, country, region, city, distinct_id) VALUES
('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'Chrome', 'Windows', 'Desktop', '1920x1080', 'en-US', 'US', 'California', 'San Francisco', 'user_abc123'),
('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a52', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'Firefox', 'macOS', 'Desktop', '1440x900', 'en-GB', 'GB', 'England', 'London', 'user_def456'),
('e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a53', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'Safari', 'iOS', 'Mobile', '375x667', 'es-ES', 'ES', 'Madrid', 'Madrid', 'user_ghi789');

-- Website Events
INSERT INTO public.website_event (event_id, website_id, session_id, url_path, url_query, referrer_path, referrer_domain, page_title, event_type, event_name, visit_id, hostname) VALUES
('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a61', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', '/', NULL, NULL, NULL, 'Home Page', 1, 'page_view', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a61', 'demo.example.com'),
('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a62', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', '/products', 'category=electronics', '/', 'google.com', 'Products', 1, 'page_view', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a61', 'demo.example.com'),
('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a63', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', '/products', 'category=electronics', NULL, NULL, 'Products', 2, 'add_to_cart', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a61', 'demo.example.com'),
('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a64', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a53', '/', NULL, NULL, NULL, 'Launch Page', 1, 'page_view', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a64', 'launch.example.com'),
('f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a65', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a53', '/contact', NULL, '/', 'launch.example.com', 'Contact Us', 1, 'page_view', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a64', 'launch.example.com');


-- Event Data
INSERT INTO public.event_data (event_data_id, website_id, website_event_id, data_key, string_value, number_value, date_value, data_type) VALUES
('a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a71', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a63', 'product_id', NULL, 12345.0000, NULL, 2),
('a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a72', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a63', 'product_name', 'Laptop Pro', NULL, NULL, 1),
('a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a73', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a65', 'form_submission', 'true', NULL, NULL, 1);

-- Session Data
INSERT INTO public.session_data (session_data_id, website_id, session_id, data_key, string_value, number_value, date_value, data_type, distinct_id) VALUES
('a2eebc99-9c0b-4ef8-bb6d-6bb9bd380a81', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', 'utm_source', 'google', NULL, NULL, 1, 'user_abc123'),
('a2eebc99-9c0b-4ef8-bb6d-6bb9bd380a82', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a51', 'screen_height', NULL, 1080.0000, NULL, 2, 'user_abc123'),
('a2eebc99-9c0b-4ef8-bb6d-6bb9bd380a83', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a42', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a53', 'referral_channel', 'social_media', NULL, NULL, 1, 'user_ghi789');

-- Reports
INSERT INTO public.report (report_id, user_id, website_id, type, name, description, parameters) VALUES
('a3eebc99-9c0b-4ef8-bb6d-6bb9bd380a91', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'dashboard', 'Website Overview', 'A high-level overview of website traffic and engagement.', '{"metrics": ["page_views", "sessions", "bounce_rate"], "timeframe": "last_30_days"}'),
('a3eebc99-9c0b-4ef8-bb6d-6bb9bd380a92', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a41', 'custom', 'Product Conversion Funnel', 'Tracks user journey through product pages to purchase.', '{"funnel_steps": ["page_view_product", "add_to_cart", "checkout_start", "purchase_complete"], "product_category": "electronics"}');
