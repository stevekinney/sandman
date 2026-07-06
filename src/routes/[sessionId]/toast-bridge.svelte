<script lang="ts">
	/**
	 * toast-bridge.svelte — hands the enclosing ToastRegion's imperative API up
	 * to the page. `useToast()` reads Svelte context, so it must be called from
	 * a component mounted inside `<ToastRegion>` — the page itself is outside
	 * that context boundary.
	 */
	import { useToast, type ToastApi } from '@lostgradient/cinder';

	let { register }: { register: (api: ToastApi) => void } = $props();

	// useToast() must run during init (it reads context); registration runs in
	// an effect so a changed `register` prop re-registers against the same api.
	const api = useToast();
	$effect(() => {
		register(api);
	});
</script>
