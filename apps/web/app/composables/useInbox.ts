import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
} from 'vue';
import { useRoute, useRouter } from '#app';
import type {
  ConversationView,
  ConversationNoteView,
  ConversationEventView,
  CurrentUserView,
  OrganizationView,
  MembershipView,
  Page,
} from '@smartdesk/shared';
import { ClientError } from '../services/api';
import { useSupportClient } from './useSupportClient';

export const statusLabel: Record<string, string> = {
  ai_active: 'AI 接待中',
  waiting_human: '等待接待',
  human_active: '人工接待中',
  closed: '已关闭',
};

export function useInbox() {
  const route = useRoute(),
    router = useRouter();
  const organizationId = String(route.params.organizationId);
  const base = `/app/o/${organizationId}/inbox`;
  const { state, client } = useSupportClient();
  const user = ref<CurrentUserView>(),
    organization = ref<OrganizationView>();
  const members = ref<MembershipView[]>([]),
    available = ref<MembershipView[]>([]);
  const me = computed(() =>
    members.value.find((m) => m.userId === user.value?.id),
  );
  const isAdmin = computed(() => me.value?.role === 'admin');
  const ready = ref(false),
    loading = ref(true),
    error = ref('');
  const view = ref('waiting'),
    filter = ref('');
  const list = ref<ConversationView[]>([]),
    nextCursor = ref<string | null>(null),
    listError = ref(''),
    listLoading = ref(false);
  const selectedId = computed(() =>
    String(router.currentRoute.value.params.conversationId ?? ''),
  );
  const navigating = ref(false);
  const detail = ref<ConversationView | null>(null),
    detailError = ref(''),
    detailLoading = ref(false),
    verified = ref(false);
  const pane = ref<'list' | 'chat' | 'details'>('list'),
    mode = ref<'public' | 'notes'>('public');
  const notes = ref<ConversationNoteView[]>([]),
    noteCursor = ref<string | null>(null),
    notesError = ref(''),
    notesLoading = ref(false);
  const events = ref<ConversationEventView[]>([]),
    eventCursor = ref<string | null>(null),
    eventsError = ref('');
  const drafts = reactive(new Map<string, { public: string; notes: string }>());
  const draft = computed(() => {
    if (!drafts.has(selectedId.value))
      drafts.set(selectedId.value, { public: '', notes: '' });
    return drafts.get(selectedId.value)!;
  });
  const busy = ref(false),
    actionError = ref(''),
    notice = ref('');
  const action = ref(''),
    target = ref(''),
    reason = ref(''),
    resolution = ref('unconfirmed');
  const canSend = computed(
    () =>
      !navigating.value &&
      verified.value &&
      detail.value?.status === 'human_active' &&
      detail.value.assignedMembershipId === me.value?.id,
  );
  const canManage = computed(
    () =>
      verified.value &&
      !!detail.value &&
      (isAdmin.value || detail.value.assignedMembershipId === me.value?.id),
  );
  const canNote = computed(
    () => canManage.value && detail.value?.status !== 'closed',
  );
  const name = (id: string | null) =>
    members.value.find((m) => m.id === id)?.displayName ??
    (id ? '团队成员' : '尚未分配');
  let alive = true,
    selection = 0,
    listGeneration = 0,
    detailGeneration = 0,
    listPages = 1,
    notePages = 1,
    polling = false;
  let release: (() => void) | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let command:
    | { signature: string; id: string; body: Record<string, unknown> }
    | undefined;
  const noteRequests = new Map<string, { content: string; id: string }>();
  const message = (e: unknown) =>
    e instanceof Error ? e.message : '请求失败，请重试';
  const current = (id: string, generation: number) =>
    alive && id === selectedId.value && generation === selection;
  function revoke() {
    selection++;
    listGeneration++;
    detailGeneration++;
    ready.value = false;
    verified.value = false;
    release?.();
    release = undefined;
    detail.value = null;
    list.value = [];
    notes.value = [];
    events.value = [];
    members.value = [];
    available.value = [];
    drafts.clear();
    noteRequests.clear();
    error.value = '登录或成员权限已失效，请重新登录或切换企业。';
  }
  watch(
    () => state.value?.connection,
    (value) => {
      if (value === 'expired') revoke();
    },
  );
  async function refreshList(more = false) {
    const generation = ++listGeneration,
      query = new URLSearchParams({ view: view.value, limit: '50' });
    if (filter.value) query.set('status', filter.value);
    if (more && nextCursor.value) query.set('cursor', nextCursor.value);
    listLoading.value = true;
    try {
      let page = await client().request<Page<ConversationView>>(
        `/conversations?${query}`,
      );
      const items = [...page.items];
      if (!more)
        for (let index = 1; index < listPages && page.nextCursor; index++) {
          if (!alive || generation !== listGeneration || !ready.value) return;
          query.set('cursor', page.nextCursor);
          page = await client().request<Page<ConversationView>>(
            `/conversations?${query}`,
          );
          items.push(...page.items);
        }
      if (!alive || generation !== listGeneration || !ready.value) return;
      list.value = more
        ? [
            ...list.value,
            ...items.filter(
              (item) => !list.value.some((old) => old.id === item.id),
            ),
          ]
        : items;
      if (more) listPages++;
      nextCursor.value = page.nextCursor;
      listError.value = '';
    } catch (e) {
      if (alive && generation === listGeneration) listError.value = message(e);
    } finally {
      if (alive && generation === listGeneration) listLoading.value = false;
    }
  }
  async function refreshPeople() {
    const [firstPage, online] = await Promise.all([
      client().request<Page<MembershipView>>('/memberships?limit=100'),
      client().request<MembershipView[]>('/presence'),
    ]);
    let people = firstPage;
    const items = [...people.items];
    while (people.nextCursor) {
      if (!alive || !ready.value) return;
      people = await client().request<Page<MembershipView>>(
        `/memberships?limit=100&cursor=${encodeURIComponent(people.nextCursor)}`,
      );
      items.push(...people.items);
    }
    if (!alive || !ready.value) return;
    members.value = items;
    available.value = online;
  }
  async function refreshDetail() {
    const id = selectedId.value,
      generation = selection,
      requestGeneration = ++detailGeneration;
    if (!id || !ready.value) return;
    try {
      const value = await client().request<ConversationView>(
        `/conversations/${id}`,
      );
      if (
        !current(id, generation) ||
        !ready.value ||
        requestGeneration !== detailGeneration
      )
        return;
      if (detail.value && value.version < detail.value.version) return;
      detail.value = value;
      verified.value = true;
      detailError.value = '';
      if (!release) release = client().openConversation(id);
    } catch (e) {
      if (!current(id, generation) || requestGeneration !== detailGeneration)
        return;
      verified.value = false;
      detailError.value = message(e);
      if (e instanceof ClientError && [401, 403, 404].includes(e.status)) {
        release?.();
        release = undefined;
        detail.value = null;
        notes.value = [];
        events.value = [];
        detailError.value = '会话已不可访问。当前输入保留在本页，发送已禁用。';
        void refreshList();
      }
    }
  }
  async function refreshNotes(more = false) {
    const id = selectedId.value,
      generation = selection;
    if (!verified.value || !id || notesLoading.value) return;
    notesLoading.value = true;
    const query = new URLSearchParams({ limit: '50' });
    if (more && noteCursor.value) query.set('cursor', noteCursor.value);
    try {
      let page = await client().request<Page<ConversationNoteView>>(
        `/conversations/${id}/notes?${query}`,
      );
      const items = [...page.items];
      if (!more)
        for (let index = 1; index < notePages && page.nextCursor; index++) {
          if (!current(id, generation) || !verified.value) return;
          query.set('cursor', page.nextCursor);
          page = await client().request<Page<ConversationNoteView>>(
            `/conversations/${id}/notes?${query}`,
          );
          items.push(...page.items);
        }
      if (!current(id, generation) || !verified.value) return;
      notes.value = more
        ? [
            ...notes.value,
            ...items.filter((n) => !notes.value.some((old) => old.id === n.id)),
          ]
        : items;
      if (more) notePages++;
      noteCursor.value = page.nextCursor;
      notesError.value = '';
    } catch (e) {
      if (current(id, generation)) notesError.value = message(e);
    } finally {
      if (current(id, generation)) notesLoading.value = false;
    }
  }
  async function refreshEvents(more = false) {
    const id = selectedId.value,
      generation = selection;
    if (!verified.value || !id) return;
    const query = new URLSearchParams({ limit: '50' });
    if (more && eventCursor.value) query.set('cursor', eventCursor.value);
    try {
      const page = await client().request<Page<ConversationEventView>>(
        `/conversations/${id}/events?${query}`,
      );
      if (!current(id, generation) || !verified.value) return;
      events.value = more ? [...events.value, ...page.items] : page.items;
      eventCursor.value = page.nextCursor;
      eventsError.value = '';
    } catch (e) {
      if (current(id, generation)) eventsError.value = message(e);
    }
  }
  async function select() {
    selection++;
    notePages = 1;
    release?.();
    release = undefined;
    detail.value = null;
    verified.value = false;
    detailError.value = '';
    actionError.value = '';
    notice.value = '';
    notes.value = [];
    notesLoading.value = false;
    events.value = [];
    noteCursor.value = null;
    eventCursor.value = null;
    notesError.value = '';
    eventsError.value = '';
    mode.value = 'public';
    action.value = '';
    reason.value = '';
    target.value = '';
    pane.value = selectedId.value ? 'chat' : 'list';
    detailLoading.value = !!selectedId.value;
    const generation = selection;
    await refreshDetail();
    if (generation === selection) {
      detailLoading.value = false;
      await refreshEvents();
    }
  }
  watch(selectedId, () => {
    if (ready.value) void select();
  });
  watch([view, filter], () => {
    listPages = 1;
    if (ready.value) void refreshList();
  });
  watch(mode, (value) => {
    if (value === 'notes') void refreshNotes();
  });
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!alive) return;
      if (!polling && ready.value && document.visibilityState !== 'hidden') {
        polling = true;
        try {
          await Promise.all([
            listLoading.value ? Promise.resolve() : refreshList(),
            refreshDetail(),
            refreshPeople(),
          ]);
          if (mode.value === 'notes') await refreshNotes();
        } catch (e) {
          if (alive && ready.value) listError.value = message(e);
        } finally {
          polling = false;
        }
      }
      if (alive) schedule();
    }, 3000);
  }
  async function initialize() {
    loading.value = true;
    error.value = '';
    try {
      const account = await client().request<CurrentUserView>('/auth/me');
      if (!alive) return;
      const membership = account.memberships.find(
        (m) => m.organizationId === organizationId,
      );
      if (!membership) throw new Error('当前账号没有该企业的有效成员身份');
      const org = await client().request<OrganizationView>(
        `/organizations/${organizationId}`,
        { organizationId },
      );
      if (!alive) return;
      client().setIdentity({
        kind: 'member',
        userId: account.id,
        membershipId: membership.id,
        organizationId,
      });
      user.value = account;
      organization.value = org;
      ready.value = true;
      await refreshPeople();
      await Promise.all([refreshList(), select()]);
      schedule();
    } catch (e) {
      if (alive) error.value = message(e);
    } finally {
      if (alive) loading.value = false;
    }
  }
  async function availability() {
    if (!me.value || busy.value) return;
    busy.value = true;
    actionError.value = '';
    try {
      await client().request('/memberships/me/availability', {
        method: 'PATCH',
        commandId: crypto.randomUUID(),
        body: {
          availability:
            me.value.availability === 'available' ? 'away' : 'available',
        },
      });
      await refreshPeople();
    } catch (e) {
      if (alive) actionError.value = message(e);
    } finally {
      if (alive) busy.value = false;
    }
  }
  async function runCommand(kind: string) {
    if (!detail.value || !verified.value || busy.value) return;
    const id = selectedId.value,
      generation = selection;
    const body: Record<string, unknown> = {
      expectedVersion: detail.value.version,
    };
    if (kind === 'assign' || kind === 'transfer')
      body.membershipId =
        kind === 'assign' && !target.value ? me.value?.id : target.value;
    if (['transfer', 'reopen'].includes(kind) || reason.value)
      body.reason = reason.value;
    if (kind === 'close') body.resolution = resolution.value;
    const signature = JSON.stringify({
      id,
      kind,
      target: body.membershipId,
      reason: body.reason,
      resolution: body.resolution,
    });
    if (command?.signature !== signature)
      command = { signature, id: crypto.randomUUID(), body };
    busy.value = true;
    actionError.value = '';
    notice.value = '';
    try {
      await client().request(`/conversations/${id}/${kind}`, {
        method: 'POST',
        commandId: command.id,
        body: command.body,
      });
      if (!current(id, generation)) return;
      command = undefined;
      action.value = '';
      reason.value = '';
      target.value = '';
      notice.value = '操作已保存';
    } catch (e) {
      if (e instanceof ClientError && e.status >= 400 && e.status < 500)
        command = undefined;
      if (current(id, generation))
        actionError.value =
          e instanceof ClientError && e.status === 409
            ? `状态已变化（409）：${message(e)}。已刷新，请确认当前负责人后重试。`
            : message(e);
    } finally {
      if (alive) busy.value = false;
      if (current(id, generation)) {
        await refreshDetail();
        const results = await Promise.allSettled([
          refreshList(),
          refreshPeople(),
          refreshEvents(),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (
          failure?.status === 'rejected' &&
          current(id, generation) &&
          ready.value
        )
          actionError.value = message(failure.reason);
      }
    }
  }
  async function submit() {
    if (busy.value) return;
    actionError.value = '';
    notice.value = '';
    if (mode.value === 'public') {
      if (!canSend.value) return;
      try {
        client().send(draft.value.public);
        draft.value.public = '';
      } catch (e) {
        actionError.value = message(e);
      }
      return;
    }
    if (!canNote.value || !draft.value.notes.trim()) return;
    const id = selectedId.value,
      generation = selection,
      content = draft.value.notes;
    let request = noteRequests.get(id);
    if (!request || request.content !== content) {
      request = { content, id: crypto.randomUUID() };
      noteRequests.set(id, request);
    }
    busy.value = true;
    try {
      await client().request(`/conversations/${id}/notes`, {
        method: 'POST',
        body: { clientNoteId: request.id, content },
      });
      if (!current(id, generation)) return;
      if (draft.value.notes === content) draft.value.notes = '';
      noteRequests.delete(id);
      notice.value = '内部备注已保存，仅团队可见';
      await refreshNotes();
    } catch (e) {
      if (current(id, generation)) {
        actionError.value = message(e);
        await refreshDetail();
      }
    } finally {
      if (alive) busy.value = false;
    }
  }
  async function markRead() {
    const id = selectedId.value,
      generation = selection;
    if (
      !verified.value ||
      mode.value !== 'public' ||
      pane.value !== 'chat' ||
      !state.value ||
      state.value.loading ||
      document.visibilityState === 'hidden'
    )
      return;
    try {
      await client().request(`/conversations/${id}/read`, {
        method: 'POST',
        body: { lastReadSeq: state.value.lastContiguousSeq },
      });
      if (current(id, generation)) {
        notice.value = '已标记当前加载的消息为已读';
        await refreshList();
      }
    } catch (e) {
      if (current(id, generation)) actionError.value = message(e);
    }
  }
  async function logout() {
    try {
      await client().request('/auth/logout', { method: 'POST', body: {} });
      client().setIdentity(null);
      revoke();
      await router.push('/login');
    } catch (e) {
      if (alive) actionError.value = message(e);
    }
  }
  async function open(id: string) {
    if (navigating.value) return;
    if (id === selectedId.value) {
      pane.value = 'chat';
      return;
    }
    navigating.value = true;
    try {
      await router.push(`${base}/${id}`);
    } catch (e) {
      if (alive) actionError.value = message(e);
    } finally {
      if (alive) navigating.value = false;
    }
  }
  onMounted(initialize);
  onBeforeUnmount(() => {
    alive = false;
    selection++;
    listGeneration++;
    clearTimeout(timer);
    release?.();
    drafts.clear();
    noteRequests.clear();
  });
  return {
    state,
    client,
    user,
    organization,
    me,
    isAdmin,
    members,
    available,
    ready,
    loading,
    error,
    view,
    filter,
    list,
    nextCursor,
    listError,
    listLoading,
    selectedId,
    navigating,
    detail,
    detailError,
    detailLoading,
    verified,
    pane,
    mode,
    notes,
    noteCursor,
    notesError,
    notesLoading,
    events,
    eventCursor,
    eventsError,
    draft,
    busy,
    actionError,
    notice,
    action,
    target,
    reason,
    resolution,
    canSend,
    canManage,
    canNote,
    name,
    refreshList,
    refreshDetail,
    refreshNotes,
    refreshEvents,
    initialize,
    availability,
    runCommand,
    submit,
    markRead,
    logout,
    open,
  };
}
