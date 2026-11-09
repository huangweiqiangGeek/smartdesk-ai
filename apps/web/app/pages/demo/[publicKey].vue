<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRuntimeConfig } from '#app';
const route = useRoute();
const config = useRuntimeConfig();
const publicKey = String(route.params.publicKey);
const error = ref('');
let script: HTMLScriptElement | undefined;
onMounted(() => {
  try {
    if (!/^[a-f0-9-]{36}$/i.test(publicKey))
      throw new Error('演示入口的站点标识无效');
    const origin = new URL(
      String(config.public.widgetOrigin || location.origin),
    );
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password
    )
      throw new Error('客服服务地址无效');
    script = document.createElement('script');
    script.src = new URL('/widget-loader.js', origin.origin).href;
    script.dataset.publicKey = publicKey;
    script.async = true;
    script.onerror = () => {
      error.value = '客服加载失败，请检查服务地址后刷新页面。';
    };
    document.body.append(script);
  } catch (e) {
    error.value = e instanceof Error ? e.message : '客服入口不可用';
  }
});
onBeforeUnmount(() => {
  script?.remove();
  document
    .querySelector(`[data-smartdesk-widget="${publicKey}"]`)
    ?.dispatchEvent(new Event('smartdesk:dispose'));
});
</script>

<template>
  <main class="demo">
    <div class="demo-banner">
      合成演示数据 · 以下品牌、项目和方案均为虚构；客服消息会通过真实服务保存。
    </div>
    <nav aria-label="演示导航">
      <a class="brand" href="#">墨舟 <span>WORKSPACE</span></a
      ><a href="#features">产品</a><a href="#plans">方案</a
      ><a href="/login">客服工作台登录</a>
    </nav>
    <section class="hero">
      <div>
        <p class="eyebrow">让项目回到事情本身</p>
        <h1>团队的每一步，<br />都有清楚的去向。</h1>
        <p class="intro">
          把分散的任务、讨论和进度放在一个地方。给团队留出专注工作的空间。
        </p>
        <a class="cta" href="#plans">看看适合你的方案 <span>↘</span></a>
        <p class="help">
          想了解邀请成员、权限或账单？点击右下角「联系客服」。当前提供人工接待，AI
          自动回复尚未开放。
        </p>
      </div>
      <aside class="preview" aria-label="合成项目示例">
        <div class="preview-top">产品发布 <small>演示项目</small></div>
        <h2>本周，一起完成</h2>
        <ul>
          <li><span class="dot done" />整理客户反馈 <small>已完成</small></li>
          <li><span class="dot" />梳理发布清单 <small>进行中</small></li>
          <li><span class="dot" />邀请协作成员 <small>待开始</small></li>
        </ul>
        <p>周一 → 周五 <span>3 项任务</span></p>
      </aside>
    </section>
    <section id="features" class="features">
      <article>
        <span>01</span>
        <h2>任务有归属</h2>
        <p>负责人、截止日期和进展，放在同一条记录里。</p>
      </article>
      <article>
        <span>02</span>
        <h2>讨论有上下文</h2>
        <p>围绕具体任务协作，减少往返查找的信息。</p>
      </article>
      <article>
        <span>03</span>
        <h2>进度看得见</h2>
        <p>用清晰的状态，知道下一步需要谁来推进。</p>
      </article>
    </section>
    <section id="plans" class="plans">
      <p class="eyebrow">演示方案 · 不提供购买</p>
      <h2>从一个小团队开始。</h2>
      <p>基础版：任务与讨论 · 团队版：共享空间与成员权限。</p>
      <p>
        这些内容仅用于体验网站咨询场景。发送问题后，可使用自己的客服账号进入工作台接待；本页不会提供或自动登录后台账号。
      </p>
    </section>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <footer>墨舟是虚构 SaaS 品牌 · 客服由 SmartDesk 提供</footer>
  </main>
</template>

<style scoped>
.demo {
  min-height: 100vh;
  color: #19332e;
  background: #fafbf8;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
}
.demo-banner {
  padding: 10px 24px;
  text-align: center;
  background: #e9eee8;
  font-size: 12px;
}
nav {
  display: flex;
  align-items: center;
  gap: 32px;
  max-width: 1180px;
  margin: auto;
  padding: 28px 32px;
}
a {
  color: inherit;
  text-decoration: none;
}
a:focus-visible {
  outline: 3px solid #b88c32;
  outline-offset: 4px;
}
.brand {
  font-size: 27px;
  font-weight: 700;
  margin-right: auto;
}
.brand span {
  font-size: 10px;
  letter-spacing: 2px;
  display: block;
}
.hero {
  display: grid;
  grid-template-columns: 1.2fr 1fr;
  gap: 80px;
  max-width: 1120px;
  margin: auto;
  padding: 70px 32px 90px;
}
.eyebrow {
  font-size: 13px;
  letter-spacing: 2px;
  color: #587568;
}
h1 {
  font-size: clamp(34px, 4.2vw, 58px);
  line-height: 1.35;
  letter-spacing: -1px;
  margin: 25px 0;
  font-weight: 650;
}
.intro {
  max-width: 420px;
  font-size: 17px;
  line-height: 1.9;
  color: #587064;
}
.cta {
  display: inline-flex;
  gap: 30px;
  background: #183f35;
  color: white;
  padding: 16px 24px;
  margin: 20px 0;
}
.help {
  max-width: 400px;
  font-size: 13px;
  line-height: 1.8;
  color: #65756b;
}
.preview {
  align-self: center;
  border: 1px solid #bcc9bd;
  padding: 28px;
  background: #edf1e8;
  transform: rotate(-2deg);
  box-shadow: 18px 18px 0 #dce5d7;
}
.preview-top {
  display: flex;
  justify-content: space-between;
  border-bottom: 1px solid #bdcbbd;
  padding-bottom: 18px;
}
.preview small {
  color: #5b7266;
  font-size: 12px;
}
.preview h2 {
  font-size: 22px;
  margin: 25px 0;
}
.preview ul {
  list-style: none;
  padding: 0;
}
.preview li {
  padding: 16px 0;
  border-bottom: 1px solid #d1dacc;
  display: flex;
  align-items: center;
  gap: 10px;
}
.preview li small {
  margin-left: auto;
}
.dot {
  width: 9px;
  height: 9px;
  border: 1px solid #54755a;
  border-radius: 50%;
}
.done {
  background: #54755a;
}
.preview p {
  font-size: 12px;
  margin-top: 24px;
}
.preview p span {
  float: right;
}
.features {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 48px;
  max-width: 1120px;
  margin: auto;
  padding: 50px 32px;
  border-top: 1px solid #d4dcd1;
}
.features span {
  color: #8c794c;
  font-size: 13px;
}
.features h2 {
  font-size: 21px;
}
.features p,
.plans p {
  line-height: 1.8;
  color: #587064;
}
.plans {
  max-width: 1120px;
  margin: auto;
  padding: 50px 32px 80px;
}
.plans h2 {
  font-size: 32px;
}
.plans p {
  max-width: 650px;
}
footer {
  border-top: 1px solid #d4dcd1;
  padding: 28px 32px 100px;
  font-size: 12px;
  color: #65756b;
}
@media (max-width: 700px) {
  nav {
    padding: 20px;
    gap: 16px;
    font-size: 12px;
  }
  nav a:nth-child(2),
  nav a:nth-child(3) {
    display: none;
  }
  .hero {
    grid-template-columns: 1fr;
    gap: 40px;
    padding: 32px 24px 60px;
  }
  .preview {
    margin-right: 14px;
  }
  .features {
    grid-template-columns: 1fr;
    gap: 24px;
    padding: 32px 24px;
  }
  .plans {
    padding: 32px 24px 80px;
  }
}
</style>
