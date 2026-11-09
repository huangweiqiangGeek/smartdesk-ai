<script setup lang="ts">
import type {
  MembershipView,
  OrganizationView,
  Page,
  UserView,
} from '@smartdesk/shared';
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { navigateTo, useRoute } from '#app';
import { useIdentityApi } from '../composables/useIdentityApi';
import { useSupportClient } from '../composables/useSupportClient';
import { staleContext, type RequestOptions } from '../services/api';
const props = defineProps<{
  mode:
    | 'login'
    | 'register'
    | 'organizations'
    | 'onboarding'
    | 'invite'
    | 'organization';
}>();
const rawApi = useIdentityApi();
const support = useSupportClient();
let active = true;
const api = async <T,>(path: string, options: RequestOptions = {}) => {
  const result = await rawApi<T>(path, options);
  if (!active) throw staleContext();
  return result;
};
const route = useRoute();
const email = ref('');
const password = ref('');
const displayName = ref('');
const name = ref('');
const zone = ref('Asia/Shanghai');
const busy = ref(false);
const loading = ref(true);
const error = ref('');
const user = ref<UserView | null>(null);
const organizations = ref<OrganizationView[]>([]);
const organization = ref<OrganizationView | null>(null);
const nextCursor = ref<string | null>(null);
const invitation = ref<{
  organizationName: string;
  role: string;
  expiresAt: string;
} | null>(null);
const token = ref('');
watch(
  () => support.state.value?.connection,
  (connection) => {
    if (connection !== 'expired') return;
    user.value = null;
    organizations.value = [];
    organization.value = null;
    nextCursor.value = null;
    error.value = '登录或企业权限已失效，请重新登录或选择企业。';
  },
  { flush: 'sync' },
);
const title = computed(
  () =>
    ({
      login: '欢迎回来',
      register: '创建你的账号',
      organizations: '选择工作企业',
      onboarding: '创建企业',
      invite: '加入客服团队',
      organization: organization.value?.name ?? '企业工作区',
    })[props.mode],
);
let commandId = '';
let commandBody = '';
function command(body: Record<string, unknown>) {
  const key = JSON.stringify(body);
  if (!commandId || key !== commandBody) {
    commandId = crypto.randomUUID();
    commandBody = key;
  }
  return commandId;
}
async function loadMore() {
  if (busy.value) return;
  busy.value = true;
  try {
    const page = await api<Page<OrganizationView>>(
      `/organizations${nextCursor.value ? `?cursor=${encodeURIComponent(nextCursor.value)}` : ''}`,
    );
    organizations.value.push(...page.items);
    nextCursor.value = page.nextCursor;
  } finally {
    busy.value = false;
  }
}
async function load() {
  loading.value = true;
  error.value = '';
  try {
    if (props.mode === 'invite') {
      token.value =
        window.location.hash.slice(1) ||
        sessionStorage.getItem('smartdesk-invite') ||
        '';
      if (token.value) {
        sessionStorage.setItem('smartdesk-invite', token.value);
        window.history.replaceState(null, '', '/invite');
      }
      invitation.value = await api('/invitations/preview', {
        method: 'POST',
        body: { token: token.value },
      });
      try {
        user.value = await api<UserView>('/auth/me');
      } catch {
        user.value = null;
      }
    } else if (!['login', 'register'].includes(props.mode)) {
      user.value = await api<UserView>('/auth/me');
      if (props.mode === 'organizations') {
        organizations.value = [];
        nextCursor.value = null;
        await loadMore();
      }
      if (props.mode === 'organization') {
        const id = String(route.params.organizationId);
        const result = await api<
          OrganizationView & { membership: MembershipView }
        >(`/organizations/${id}`, {
          organizationId: id,
        });
        organization.value = result;
        support.client().setIdentity({
          kind: 'member',
          userId: user.value.id,
          organizationId: id,
          membershipId: result.membership.id,
        });
      }
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (props.mode === 'login' || props.mode === 'register') {
      await api(`/auth/${props.mode}`, {
        method: 'POST',
        body: {
          email: email.value,
          password: password.value,
          ...(props.mode === 'register'
            ? { displayName: displayName.value }
            : {}),
        },
      });
      password.value = '';
      await navigateTo(
        sessionStorage.getItem('smartdesk-invite')
          ? '/invite'
          : '/app/organizations',
      );
    } else if (props.mode === 'onboarding') {
      const body = { name: name.value, timezone: zone.value };
      const result = await api<OrganizationView>('/organizations', {
        method: 'POST',
        body,
        commandId: command(body),
      });
      await navigateTo(`/app/o/${result.id}`);
    } else if (props.mode === 'invite') {
      const body = { token: token.value };
      const result = await api<{ organization: OrganizationView }>(
        '/invitations/accept',
        { method: 'POST', body, commandId: command(body) },
      );
      sessionStorage.removeItem('smartdesk-invite');
      token.value = '';
      await navigateTo(`/app/o/${result.organization.id}`);
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function logout() {
  if (busy.value) return;
  busy.value = true;
  support.client().setIdentity(null);
  try {
    await api('/auth/logout', { method: 'POST', body: {} });
    user.value = null;
    organization.value = null;
    organizations.value = [];
    await navigateTo('/login');
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
onMounted(load);
onBeforeUnmount(() => {
  active = false;
});
</script>

<template>
  <main class="entry">
    <aside class="identity-brand">
      <NuxtLink to="/app/organizations" class="wordmark"
        >SmartDesk<span>AI</span></NuxtLink
      >
      <div>
        <h2>每一次咨询，<br />都有回应。</h2>
        <p>让团队从同一个地方<br />开始服务客户。</p>
      </div>
      <p class="brand-foot">客户服务 · 团队协作</p>
    </aside>
    <section class="entry-content" :aria-busy="busy || loading">
      <nav v-if="user" class="account-nav">
        <span>{{ user.displayName }}</span
        ><button class="text-button" :disabled="busy" @click="logout">
          退出登录
        </button>
      </nav>
      <div class="entry-panel">
        <h1>{{ title }}</h1>
        <p v-if="mode === 'login'" class="intro">
          登录后，继续你的客户服务工作。
        </p>
        <p v-if="mode === 'register'" class="intro">
          创建账号后，可以加入团队或创建企业。
        </p>
        <p v-if="loading" role="status">正在加载…</p>
        <div v-if="error" role="alert" class="error">
          <p>{{ error }}</p>
          <button
            v-if="!['login', 'register', 'onboarding'].includes(mode)"
            class="text-button"
            @click="load"
          >
            重新加载
          </button>
        </div>
        <form
          v-if="mode === 'login' || mode === 'register'"
          @submit.prevent="submit"
        >
          <label v-if="mode === 'register'"
            >显示名<input
              v-model="displayName"
              name="displayName"
              autocomplete="name"
              required
              maxlength="100"
          /></label>
          <label
            >邮箱<input
              v-model="email"
              type="email"
              name="email"
              autocomplete="email"
              required
              maxlength="254"
          /></label>
          <label
            >密码<input
              v-model="password"
              type="password"
              name="password"
              :autocomplete="
                mode === 'register' ? 'new-password' : 'current-password'
              "
              required
              aria-describedby="password-help"
          /></label>
          <p id="password-help" class="hint">密码为 12—128 个字符。</p>
          <button class="primary" :disabled="busy">
            {{ busy ? '请稍候…' : mode === 'register' ? '创建账号' : '登录' }}
          </button>
          <p class="switch">
            {{ mode === 'register' ? '已有账号？' : '还没有账号？' }}
            <NuxtLink :to="mode === 'register' ? '/login' : '/register'">{{
              mode === 'register' ? '登录' : '注册'
            }}</NuxtLink>
          </p>
        </form>
        <template v-else-if="mode === 'organizations' && !loading && user">
          <p class="intro">选择企业进入工作区。不同企业的资料相互独立。</p>
          <p v-if="!organizations.length && !error" class="empty">
            你还没有加入企业。可以创建企业，或打开同事发来的邀请链接。
          </p>
          <NuxtLink
            v-for="o in organizations"
            :key="o.id"
            :to="`/app/o/${o.id}`"
            class="organization-row"
            ><strong>{{ o.name }}</strong
            ><span>{{ o.timezone }} →</span></NuxtLink
          >
          <button
            v-if="nextCursor"
            class="text-button"
            @click="loadMore().catch((e) => (error = e.message))"
          >
            加载更多
          </button>
          <NuxtLink to="/app/onboarding" class="primary link-button"
            >创建企业</NuxtLink
          >
        </template>
        <form
          v-else-if="mode === 'onboarding' && user"
          @submit.prevent="submit"
        >
          <label
            >企业名称<input
              v-model="name"
              name="organizationName"
              required
              maxlength="100"
          /></label>
          <label
            >企业时区<input
              v-model="zone"
              name="timezone"
              required
              placeholder="Asia/Shanghai"
          /></label>
          <p class="hint">时区用于日期筛选与工作量统计。</p>
          <button class="primary" :disabled="busy">
            {{ busy ? '正在创建…' : '创建企业' }}
          </button>
          <NuxtLink to="/app/organizations">返回企业列表</NuxtLink>
        </form>
        <template v-else-if="mode === 'invite' && invitation">
          <p class="intro">
            邀请你加入 <strong>{{ invitation.organizationName }}</strong
            >，身份为{{ invitation.role === 'admin' ? '管理员' : '客服' }}。
          </p>
          <p class="hint">
            有效期至
            {{ new Date(invitation.expiresAt).toLocaleString('zh-CN') }}
          </p>
          <button v-if="user" class="primary" :disabled="busy" @click="submit">
            {{ busy ? '正在加入…' : '接受邀请' }}
          </button>
          <template v-else
            ><NuxtLink to="/login" class="primary link-button"
              >登录后接受</NuxtLink
            ><NuxtLink to="/register">创建账号</NuxtLink></template
          >
        </template>
        <template v-else-if="mode === 'organization' && organization">
          <p class="intro">
            你已进入 {{ organization.name }}。企业身份已确认。
          </p>
          <dl>
            <dt>企业时区</dt>
            <dd>{{ organization.timezone }}</dd>
            <dt>接入状态</dt>
            <dd>账号与团队基础已就绪，客服接待功能开发中。</dd>
          </dl>
          <NuxtLink to="/app/organizations">切换企业</NuxtLink>
        </template>
        <NuxtLink
          v-if="
            error && !user && !['login', 'register', 'invite'].includes(mode)
          "
          to="/login"
          >前往登录</NuxtLink
        >
      </div>
    </section>
  </main>
</template>
