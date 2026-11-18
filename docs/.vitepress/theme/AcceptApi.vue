<script setup lang="ts">
// The accept API reference (docs/openapi.yaml) drawn by vitepress-openapi, as on
// pixelbar.nl/spacestate. The library is most of a megabyte, so it is loaded here,
// in the browser, on the one page that uses it, rather than in the theme for every page.
import { type Component, getCurrentInstance, onMounted, shallowRef } from "vue";
import { load } from "./openapi";

const app = getCurrentInstance()?.appContext.app;
const spec = shallowRef<Component>();
const failed = shallowRef(false);

onMounted(async () => {
	if (!app) return;
	try {
		spec.value = await load(app);
	} catch {
		failed.value = true;
	}
});
</script>

<template>
	<component :is="spec" v-if="spec" />
	<p v-else-if="failed">
		The API reference didn't load. The spec is
		<a href="https://github.com/pixelbar/pixel-phone/blob/main/docs/openapi.yaml">docs/openapi.yaml</a>.
	</p>
	<p v-else>Loading the API reference…</p>
</template>
