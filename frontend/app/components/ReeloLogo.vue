<template>
  <!-- Reelo 标志：一卷胶片（圆盘 + 四个片孔 + 中心轴），珊瑚红走 --accent，两主题自动适配 -->
  <svg :width="size" :height="size" viewBox="0 0 32 32" fill="none" aria-hidden="true">
    <rect width="32" height="32" rx="8" fill="var(--accent)" />
    <circle cx="16" cy="16" r="10" fill="none" stroke="var(--on-accent)" stroke-width="2.2" />
    <circle cx="16" cy="10.6" r="2.3" fill="var(--on-accent)" />
    <circle cx="16" cy="21.4" r="2.3" fill="var(--on-accent)" />
    <circle cx="10.6" cy="16" r="2.3" fill="var(--on-accent)" />
    <circle cx="21.4" cy="16" r="2.3" fill="var(--on-accent)" />
    <circle cx="16" cy="16" r="1.2" fill="var(--on-accent)" />
  </svg>
</template>

<script setup>
defineProps({ size: { type: Number, default: 28 } })
</script>
