-- ============================================================
-- 上课游戏 · 账号管理增量改造（2026-11-22）
-- 在 Supabase Dashboard → SQL Editor 里整段执行一次。
--
-- 做的事：
--   1. 学生表加最后登录 / 最后活动 / 最后退出时间
--   2. 登录、存档时顺手记录时间
--   3. 新增正常退出、会话检查、老师强制下线三个函数
--   4. 全班名单返回账号时间与在线状态
--   5. 撤销 student_register 的匿名执行权限（保留函数本体便于回滚）
--
-- 不改原有表结构以外的数据；不加不删学生账号。
-- ============================================================

-- 1. 账号时间字段
alter table public.students add column if not exists last_login_at  timestamptz;
alter table public.students add column if not exists last_seen_at   timestamptz;
alter table public.students add column if not exists last_logout_at timestamptz;

-- 2. 学生登录：成功时记录最后登录 / 最后活动
create or replace function public.student_login(p_name text, p_pin text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_hash  text;
  v_fail  int;
  v_lock  timestamptz;
  v_save  jsonb;
  v_token text;
  v_flag  text;
  v_secs  int;
begin
  select value into v_flag from app_settings where key = 'class_locked';
  if coalesce(v_flag, '0') = '1' then
    return jsonb_build_object('ok', false, 'code', 'class_locked');
  end if;

  select pass_hash, coalesce(fail_count, 0), locked_until, save
    into v_hash, v_fail, v_lock, v_save
    from students
   where name = p_name;

  if not found then
    return jsonb_build_object('ok', false, 'code', 'no_user');
  end if;

  if v_lock is not null and v_lock > now() then
    v_secs := ceil(extract(epoch from (v_lock - now())))::int;
    return jsonb_build_object('ok', false, 'code', 'locked', 'seconds', v_secs);
  end if;

  if v_hash is null or crypt(p_pin, v_hash) <> v_hash then
    v_fail := v_fail + 1;
    update students
       set fail_count   = v_fail,
           locked_until = case when v_fail >= 5 then now() + interval '60 seconds' else null end
     where name = p_name;
    return jsonb_build_object('ok', false, 'code', 'bad_pin');
  end if;

  update students
     set fail_count    = 0,
         locked_until  = null,
         last_login_at = now(),
         last_seen_at  = now()
   where name = p_name;

  v_token := encode(gen_random_bytes(18), 'hex');
  delete from student_sessions where expires_at < now();
  insert into student_sessions (token, sname, role, expires_at)
    values (v_token, p_name, 'student', now() + interval '12 hours');

  return jsonb_build_object(
    'ok', true,
    'token', v_token,
    'save', coalesce(v_save, '{}'::jsonb)
  );
end;
$$;

-- 3. 学生写自己的存档：顺手记录最后活动
create or replace function public.student_save(p_token text, p_save jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
begin
  select sname into v_name
    from student_sessions
   where token = p_token
     and expires_at > now()
     and role = 'student';

  if v_name is null then
    return jsonb_build_object('ok', false, 'code', 'no_session');
  end if;

  update students
     set save = coalesce(p_save - 'pass', '{}'::jsonb),
         updated_at = now(),
         last_seen_at = now()
   where name = v_name;

  return jsonb_build_object('ok', true);
end;
$$;

-- 4. 学生正常退出：记最后退出，作废自己的全部门票
create or replace function public.student_logout(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
begin
  select sname into v_name
    from student_sessions
   where token = p_token
     and expires_at > now()
     and role = 'student';

  -- 重复调用 / 门票已被老师作废：不改时间，避免把旧退出时间刷成新时间
  if v_name is null then
    return jsonb_build_object('ok', true, 'already', true);
  end if;

  update students
     set last_logout_at = now(),
         last_seen_at   = now()
   where name = v_name;

  delete from student_sessions
   where sname = v_name
     and role = 'student';

  return jsonb_build_object('ok', true, 'already', false);
end;
$$;

-- 5. 学生检查自己的门票是否还有效（30 秒轮询 / 存档被拒时也能用）
create or replace function public.student_check(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
begin
  select sname into v_name
    from student_sessions
   where token = p_token
     and expires_at > now()
     and role = 'student';

  if v_name is null then
    return jsonb_build_object('ok', false, 'code', 'no_session');
  end if;

  return jsonb_build_object('ok', true, 'name', v_name);
end;
$$;

-- 6. 老师强制下线：作废该学生全部学生会话；不在线不写退出时间
create or replace function public.teacher_kick(p_token text, p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_role  text;
  v_count int;
  v_name  text;
begin
  select role into v_role
    from student_sessions
   where token = p_token
     and expires_at > now();

  if v_role is null or v_role <> 'teacher' then
    return jsonb_build_object('ok', false, 'code', 'no_session');
  end if;

  v_name := btrim(coalesce(p_name, ''));
  if v_name = '' then
    return jsonb_build_object('ok', false, 'code', 'bad_name');
  end if;

  select count(*) into v_count
    from student_sessions
   where sname = v_name
     and role = 'student'
     and expires_at > now();

  if v_count = 0 then
    return jsonb_build_object('ok', true, 'count', 0);
  end if;

  update students
     set last_logout_at = now(),
         last_seen_at   = now()
   where name = v_name;

  delete from student_sessions
   where sname = v_name
     and role = 'student';

  return jsonb_build_object(
    'ok', true,
    'count', v_count,
    'last_logout_at', to_jsonb(now())
  );
end;
$$;

-- 7. 全班名单：补上账号时间与在线状态
create or replace function public.class_roster(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_name text;
begin
  select sname into v_name
    from student_sessions
   where token = p_token
     and expires_at > now();

  if v_name is null then
    return '[]'::jsonb;
  end if;

  return (
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'name', s.name,
                 'save', coalesce(s.save, '{}'::jsonb),
                 'updated_at', s.updated_at,
                 'last_login_at', s.last_login_at,
                 'last_seen_at', s.last_seen_at,
                 'last_logout_at', s.last_logout_at,
                 'online', exists (
                   select 1
                     from student_sessions ss
                    where ss.sname = s.name
                      and ss.role = 'student'
                      and ss.expires_at > now()
                 )
               )
               order by s.updated_at desc nulls last
             ),
             '[]'::jsonb
           )
      from students s
  );
end;
$$;

-- 8. 撤销学生自助注册的匿名入口（保留函数本体，方便回滚）
revoke execute on function public.student_register(text, text, jsonb)
  from public, anon, authenticated;

-- 9. 新函数授权给学生端匿名调用
grant execute on function public.student_logout(text) to anon;
grant execute on function public.student_check(text) to anon;
grant execute on function public.teacher_kick(text, text) to anon;

-- 10. 自检：执行后这几个函数应存在，student_register 不应再对 anon 开放
-- select proname, proacl from pg_proc
--  where proname in ('student_register','student_logout','student_check','teacher_kick');
