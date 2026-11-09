<script setup lang="ts">
import { reactive } from 'vue';
import { NuxtLink } from '#components';
import { useInbox, statusLabel } from '../composables/useInbox';
import InboxTimeline from './InboxTimeline.vue';
import '../assets/inbox.css';
const inbox = reactive(useInbox());
const handoffLabels: Record<string, string> = {
  ai_unavailable: 'AI 接待不可用，已进入人工队列',
  knowledge_insufficient: '知识不足，需要人工协助',
  customer_request: '访客请求人工服务',
  human_takeover: '团队成员主动接管',
};
function keydown(event: globalThis.KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void inbox.submit();
  }
}
const time = (value: string) =>
  new Date(value).toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
</script>

<template>
  <main class="inbox-app" :data-pane="inbox.pane">
    <header class="inbox-header">
      <NuxtLink class="wordmark" to="/app/organizations"
        >SmartDesk <span>AI</span></NuxtLink
      >
      <span class="inbox-org">{{
        inbox.organization?.name ?? '客服工作台'
      }}</span>
      <div v-if="inbox.ready" class="inbox-account">
        <span>{{ inbox.user?.displayName }}</span>
        <button :disabled="inbox.busy" @click="inbox.availability">
          {{
            inbox.me?.availability === 'available'
              ? '接待中 · 切为离开'
              : '已离开 · 开始接待'
          }}
        </button>
        <NuxtLink to="/app/organizations">切换企业</NuxtLink>
        <button @click="inbox.logout">退出登录</button>
      </div>
    </header>
    <div v-if="inbox.loading" class="inbox-state" role="status">
      正在载入工作台…
    </div>
    <div v-else-if="inbox.error" class="inbox-state">
      <p role="alert">{{ inbox.error }}</p>
      <button @click="inbox.initialize">重新加载</button>
      <NuxtLink to="/login">前往登录</NuxtLink
      ><NuxtLink to="/app/organizations">选择企业</NuxtLink>
    </div>
    <div v-else-if="inbox.ready" class="inbox-columns">
      <aside class="inbox-list" aria-label="会话列表">
        <div class="inbox-section-heading">
          <h1>收件箱</h1>
          <button :disabled="inbox.listLoading" @click="inbox.refreshList()">
            刷新列表
          </button>
        </div>
        <nav class="inbox-tabs" aria-label="会话范围">
          <button
            v-for="option in [
              { value: 'waiting', label: '待接待' },
              { value: 'mine', label: '我的' },
              { value: 'all', label: '全部有权' },
            ]"
            :key="option.value"
            :aria-pressed="inbox.view === option.value"
            @click="inbox.view = option.value"
          >
            {{ option.label }}
          </button>
        </nav>
        <label class="inbox-filter"
          >会话状态<select v-model="inbox.filter">
            <option value="">所有状态</option>
            <option v-for="(label, key) in statusLabel" :key="key" :value="key">
              {{ label }}
            </option>
          </select></label
        >
        <p class="inbox-caption">
          {{ inbox.view === 'waiting' ? '待接待咨询' : '授权会话' }} · 已加载
          {{ inbox.list.length }} 条<span v-if="inbox.nextCursor"
            >，还有更多</span
          >。角标为个人未读访客消息。
        </p>
        <p v-if="inbox.listError" role="alert" class="inbox-error">
          {{ inbox.listError }}
          <button @click="inbox.refreshList()">重试列表</button>
        </p>
        <p v-if="inbox.listLoading && !inbox.list.length" role="status">
          正在加载会话…
        </p>
        <p
          v-else-if="!inbox.list.length && !inbox.listError"
          class="inbox-empty"
        >
          {{
            inbox.view === 'waiting'
              ? '暂时没有等待接待的咨询'
              : '此范围内暂无会话'
          }}
        </p>
        <div class="inbox-list-scroll">
          <button
            v-for="conversation in inbox.list"
            :key="conversation.id"
            class="inbox-row"
            :aria-current="
              inbox.selectedId === conversation.id ? 'true' : undefined
            "
            :data-conversation="conversation.id"
            @click="inbox.open(conversation.id)"
          >
            <span class="inbox-row-top"
              ><strong>{{ conversation.customer.name || '匿名访客' }}</strong
              ><span
                v-if="conversation.unreadCount"
                class="inbox-unread"
                :aria-label="`${conversation.unreadCount} 条未读`"
                >{{ conversation.unreadCount }}</span
              ></span
            >
            <span class="inbox-preview">{{
              conversation.lastMessageSummary || '暂无公开消息'
            }}</span>
            <span class="inbox-row-meta"
              ><span>{{ statusLabel[conversation.status] }}</span
              ><span>{{
                inbox.name(conversation.assignedMembershipId)
              }}</span></span
            >
          </button>
          <button
            v-if="inbox.nextCursor"
            class="inbox-more"
            :disabled="inbox.listLoading"
            @click="inbox.refreshList(true)"
          >
            加载更多会话
          </button>
        </div>
      </aside>
      <section class="inbox-chat" aria-label="当前会话">
        <div v-if="!inbox.selectedId" class="inbox-welcome">
          <span class="inbox-eyebrow">TEAM INBOX</span>
          <h2>从一次对话开始</h2>
          <p>选择一条咨询，查看消息并开始接待。</p>
          <p class="inbox-caption">公开回复发送给访客；内部备注仅团队可见。</p>
        </div>
        <template v-else>
          <header class="inbox-chat-heading">
            <button class="inbox-mobile" @click="inbox.pane = 'list'">
              ← 会话列表
            </button>
            <div>
              <h2>
                {{
                  inbox.detail?.customer.name ||
                  (inbox.detail ? '匿名访客' : '当前会话')
                }}
              </h2>
              <p>
                {{
                  inbox.detail
                    ? statusLabel[inbox.detail.status]
                    : '正在确认访问权限'
                }}<span v-if="inbox.detail">
                  · {{ inbox.name(inbox.detail.assignedMembershipId) }}</span
                >
              </p>
            </div>
            <button class="inbox-mobile" @click="inbox.pane = 'details'">
              客户资料 →
            </button>
          </header>
          <div v-if="inbox.detail && inbox.verified" class="inbox-actions">
            <button
              v-if="
                inbox.detail.status === 'waiting_human' &&
                !inbox.detail.assignedMembershipId &&
                !inbox.isAdmin
              "
              :disabled="inbox.busy"
              @click="inbox.runCommand('claim')"
            >
              认领会话
            </button>
            <button
              v-if="
                inbox.isAdmin &&
                inbox.detail.status !== 'closed' &&
                inbox.detail.assignedMembershipId !== inbox.me?.id
              "
              :disabled="inbox.busy"
              @click="
                inbox.target = '';
                inbox.runCommand('assign');
              "
            >
              接管会话
            </button>
            <button
              v-if="inbox.isAdmin && inbox.detail.status !== 'closed'"
              @click="inbox.action = 'assign'"
            >
              指派负责人
            </button>
            <button
              v-if="inbox.canManage && inbox.detail.status !== 'closed'"
              @click="inbox.action = 'transfer'"
            >
              转交会话
            </button>
            <button
              v-if="inbox.canManage && inbox.detail.status !== 'closed'"
              @click="inbox.action = 'close'"
            >
              关闭会话
            </button>
            <button
              v-if="inbox.canManage && inbox.detail.status === 'closed'"
              @click="inbox.action = 'reopen'"
            >
              人工重开
            </button>
            <button
              :disabled="
                inbox.mode !== 'public' ||
                inbox.state?.loading ||
                !inbox.state?.lastContiguousSeq
              "
              @click="inbox.markRead"
            >
              标记已读
            </button>
          </div>
          <form
            v-if="inbox.action && inbox.verified"
            class="inbox-command"
            @submit.prevent="inbox.runCommand(inbox.action)"
          >
            <h3>
              {{
                {
                  assign: '指派负责人',
                  transfer: '转交会话',
                  close: '关闭会话',
                  reopen: '人工重开',
                }[inbox.action]
              }}
            </h3>
            <label v-if="['assign', 'transfer'].includes(inbox.action)"
              >接待成员<select v-model="inbox.target" required>
                <option value="" disabled>选择在线且可接待的成员</option>
                <option
                  v-for="member in inbox.available.filter(
                    (m) => inbox.action !== 'transfer' || m.id !== inbox.me?.id,
                  )"
                  :key="member.id"
                  :value="member.id"
                >
                  {{ member.displayName }}
                </option>
              </select></label
            >
            <label v-if="inbox.action === 'close'"
              >处理结果<select v-model="inbox.resolution">
                <option value="unconfirmed">尚未确认解决</option>
                <option value="agent_resolved">客服确认已解决</option>
              </select></label
            >
            <p v-if="inbox.action === 'close'">
              关闭后停止回复，已有工单的状态保持不变。
            </p>
            <label
              >操作理由<input
                v-model="inbox.reason"
                :required="['transfer', 'reopen'].includes(inbox.action)"
                maxlength="500"
            /></label>
            <div>
              <button class="primary" :disabled="inbox.busy">确认操作</button>
              <button type="button" @click="inbox.action = ''">取消</button>
            </div>
          </form>
          <p v-if="inbox.actionError" role="alert" class="inbox-error">
            {{ inbox.actionError }}
          </p>
          <p v-if="inbox.notice" role="status" class="inbox-notice">
            {{ inbox.notice }}
          </p>
          <p v-if="inbox.detailLoading" role="status" class="inbox-notice">
            正在加载会话…
          </p>
          <p v-if="inbox.detailError" role="alert" class="inbox-error">
            {{ inbox.detailError }}
            <button @click="inbox.refreshDetail">刷新会话</button>
          </p>
          <nav class="inbox-tabs inbox-modes" aria-label="消息模式">
            <button
              :aria-pressed="inbox.mode === 'public'"
              @click="inbox.mode = 'public'"
            >
              公开消息</button
            ><button
              :aria-pressed="inbox.mode === 'notes'"
              @click="inbox.mode = 'notes'"
            >
              内部备注 · 仅团队可见
            </button>
          </nav>
          <InboxTimeline
            v-if="inbox.mode === 'public' && inbox.verified"
            :state="inbox.state"
            :can-send="inbox.canSend"
            @older="inbox.client().loadOlder()"
            @retry="inbox.client().retry($event)"
            @recover="inbox.client().recoverNow()"
          />
          <section
            v-else-if="inbox.mode === 'notes' && inbox.verified"
            class="inbox-timeline inbox-notes"
            aria-label="团队内部备注"
          >
            <p class="inbox-caption">
              仅团队可见 · 不发送给访客，也不作为 AI 输入
            </p>
            <p v-if="inbox.notesLoading" role="status">正在加载备注…</p>
            <p v-if="inbox.notesError" role="alert">
              {{ inbox.notesError }}
              <button @click="inbox.refreshNotes()">重试备注</button>
            </p>
            <p
              v-if="
                !inbox.notes.length && !inbox.notesLoading && !inbox.notesError
              "
              class="inbox-empty"
            >
              尚无内部备注
            </p>
            <article
              v-for="note in inbox.notes"
              :key="note.id"
              class="inbox-note"
            >
              <header>
                {{ inbox.name(note.authorMembershipId) }} ·
                {{ time(note.createdAt) }} <strong>内部备注</strong>
              </header>
              <p>{{ note.content }}</p>
            </article>
            <button
              v-if="inbox.noteCursor"
              :disabled="inbox.notesLoading"
              @click="inbox.refreshNotes(true)"
            >
              更早备注
            </button>
          </section>
          <div v-else class="inbox-timeline">
            <p>确认访问权限后显示会话内容。</p>
          </div>
          <form
            class="inbox-composer"
            :class="{ 'inbox-private-composer': inbox.mode === 'notes' }"
            @submit.prevent="inbox.submit"
          >
            <label :for="`draft-${inbox.mode}`">{{
              inbox.mode === 'public' ? '公开回复' : '内部备注（仅团队可见）'
            }}</label>
            <textarea
              :id="`draft-${inbox.mode}`"
              v-model="inbox.draft[inbox.mode]"
              :disabled="inbox.navigating"
              rows="3"
              maxlength="8000"
              :placeholder="
                inbox.mode === 'public'
                  ? '写下回复…'
                  : '记录团队需要了解的信息…'
              "
              @keydown="keydown"
            />
            <div class="inbox-composer-footer">
              <span class="inbox-caption">Enter 发送 · Shift+Enter 换行</span
              ><button
                class="primary"
                :disabled="
                  inbox.busy ||
                  !(inbox.mode === 'public' ? inbox.canSend : inbox.canNote) ||
                  !inbox.draft[inbox.mode].trim()
                "
              >
                {{ inbox.mode === 'public' ? '发送回复' : '保存内部备注' }}
              </button>
            </div>
            <p
              v-if="!(inbox.mode === 'public' ? inbox.canSend : inbox.canNote)"
              class="inbox-caption"
            >
              {{
                inbox.detail?.status === 'closed'
                  ? '会话已关闭。输入已保留，人工重开后可继续。'
                  : '当前不可发送。公开回复需要先成为负责人；输入会保留。'
              }}
            </p>
          </form>
        </template>
      </section>
      <aside class="inbox-details" aria-label="客户与接待资料">
        <button class="inbox-mobile" @click="inbox.pane = 'chat'">
          ← 返回会话
        </button>
        <h2>客户资料</h2>
        <template v-if="inbox.detail && inbox.verified">
          <dl>
            <dt>姓名</dt>
            <dd>{{ inbox.detail.customer.name || '尚未提供' }}</dd>
            <dt>邮箱</dt>
            <dd>{{ inbox.detail.customer.email || '尚未提供' }}</dd>
            <dt>偏好语言</dt>
            <dd>{{ inbox.detail.customer.preferredLanguage }}</dd>
            <dt>当前负责人</dt>
            <dd>{{ inbox.name(inbox.detail.assignedMembershipId) }}</dd>
            <dt>首次转人工</dt>
            <dd>
              {{
                inbox.detail.firstHandoffAt
                  ? time(inbox.detail.firstHandoffAt)
                  : '尚未发生'
              }}
            </dd>
            <dt>转接原因</dt>
            <dd>
              {{
                handoffLabels[inbox.detail.handoffReason ?? ''] ||
                (inbox.detail.handoffReason
                  ? '已转人工，请查看操作记录'
                  : '未记录')
              }}
            </dd>
          </dl>
          <section class="inbox-unavailable">
            <h3>AI 辅助</h3>
            <p>尚未接入，当前不可用。</p>
            <p>摘要、翻译和回复建议暂不可生成，可查看原始消息继续接待。</p>
          </section>
          <section class="inbox-unavailable">
            <h3>关联工单</h3>
            <p>工单模块尚未接入。</p>
          </section>
          <details
            @toggle="
              ($event.target as HTMLDetailsElement).open &&
              inbox.refreshEvents()
            "
          >
            <summary>接待操作记录</summary>
            <p v-if="inbox.eventsError" role="alert">
              {{ inbox.eventsError }}
              <button @click="inbox.refreshEvents()">重试记录</button>
            </p>
            <p v-if="!inbox.events.length">暂无操作记录</p>
            <ol>
              <li v-for="event in inbox.events" :key="event.id">
                {{ event.toStatus ? statusLabel[event.toStatus] : '状态更新'
                }}<span v-if="event.toAssignee">
                  · {{ inbox.name(event.toAssignee) }}</span
                >
                <p v-if="event.reason">{{ event.reason }}</p>
                <small>{{ time(event.createdAt) }}</small>
              </li>
            </ol>
            <button v-if="inbox.eventCursor" @click="inbox.refreshEvents(true)">
              更多记录
            </button>
          </details>
        </template>
        <p v-else class="inbox-caption">选择有权访问的会话后显示资料。</p>
      </aside>
    </div>
  </main>
</template>
