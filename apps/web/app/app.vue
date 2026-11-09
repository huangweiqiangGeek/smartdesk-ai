<template>
  <NuxtPage :page-key="(route) => route.fullPath" />
</template>

<style>
* {
  box-sizing: border-box;
}
body {
  margin: 0;
  color: #19332e;
  background: #fafbf8;
  font-family: 'Microsoft YaHei', 'PingFang SC', sans-serif;
  line-height: 1.65;
}
a {
  color: #245f4e;
  text-underline-offset: 4px;
}
button,
input {
  font: inherit;
}
button,
a {
  -webkit-tap-highlight-color: transparent;
}
button {
  cursor: pointer;
}
:focus-visible {
  outline: 3px solid #c5a14d;
  outline-offset: 4px;
}
.entry {
  min-height: 100vh;
  display: grid;
  grid-template-columns: minmax(280px, 38%) 1fr;
}
.identity-brand {
  background: #183f35;
  color: #f3f1df;
  padding: 48px 56px;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}
.wordmark {
  color: inherit;
  text-decoration: none;
  font-weight: 700;
  font-size: 25px;
  letter-spacing: -1px;
}
.wordmark span {
  margin-left: 8px;
  font-size: 14px;
  color: #c9d8b0;
}
.identity-brand h2 {
  font-size: clamp(30px, 3.4vw, 48px);
  line-height: 1.5;
  font-weight: 500;
  letter-spacing: 1px;
}
.identity-brand p {
  color: #bccdc2;
}
.brand-foot {
  font-size: 13px;
}
.entry-content {
  padding: 28px 8%;
}
.account-nav {
  display: flex;
  justify-content: flex-end;
  gap: 24px;
  font-size: 14px;
  min-height: 40px;
}
.entry-panel {
  max-width: 460px;
  margin: 12vh auto 60px;
}
.entry-panel h1 {
  font-size: 30px;
  font-weight: 600;
  letter-spacing: -0.8px;
  margin: 0 0 12px;
}
.intro {
  color: #5d7069;
  margin: 0 0 32px;
}
form {
  display: grid;
  gap: 18px;
}
label {
  display: grid;
  gap: 7px;
  font-size: 14px;
  font-weight: 600;
}
input {
  width: 100%;
  padding: 11px 13px;
  border: 1px solid #c7d0c9;
  border-radius: 5px;
  background: white;
  color: #19332e;
}
.primary {
  background: #245b49;
  color: white;
  border: 0;
  border-radius: 5px;
  padding: 12px 20px;
  text-decoration: none;
  text-align: center;
  font-weight: 600;
}
.primary:disabled {
  opacity: 0.55;
  cursor: wait;
}
.link-button {
  display: block;
  margin: 24px 0 16px;
}
.text-button {
  border: 0;
  background: transparent;
  padding: 0;
  color: #245f4e;
  text-decoration: underline;
  text-underline-offset: 4px;
}
.hint {
  color: #6d7c75;
  font-size: 13px;
  margin: 0;
}
.switch {
  text-align: center;
  font-size: 14px;
}
.error {
  background: #fff0e9;
  color: #913f2d;
  padding: 12px 16px;
  border-left: 3px solid #b66043;
  margin: 20px 0;
}
.error p {
  margin: 0;
}
.organization-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  border-bottom: 1px solid #d8ded8;
  padding: 20px 0;
  text-decoration: none;
}
.organization-row span {
  color: #6d7c75;
  font-size: 13px;
}
.empty {
  padding: 24px 0;
  color: #61736b;
}
dl {
  border-top: 1px solid #d8ded8;
  padding-top: 24px;
}
dt {
  font-size: 13px;
  color: #6d7c75;
}
dd {
  margin: 0 0 18px;
}
@media (max-width: 720px) {
  .entry {
    display: block;
  }
  .identity-brand {
    padding: 20px 24px;
  }
  .identity-brand > div,
  .brand-foot {
    display: none;
  }
  .entry-content {
    padding: 20px 24px;
  }
  .entry-panel {
    margin: 40px auto;
  }
  .organization-row {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
