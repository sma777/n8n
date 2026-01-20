<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { N8nPromptInput, N8nPromptInputSuggestions } from '@n8n/design-system';
import type { WorkflowSuggestion } from '@n8n/design-system/types/assistant';
import { WORKFLOW_SUGGESTIONS } from '@/app/constants/workflowSuggestions';
import { useI18n } from '@n8n/i18n';
import shuffle from 'lodash/shuffle';

const emit = defineEmits<{
	submit: [prompt: string];
}>();

const i18n = useI18n();

const textInputValue = ref<string>('');
const promptInputRef = ref<InstanceType<typeof N8nPromptInput>>();

const shuffledSuggestions = computed<WorkflowSuggestion[]>(() => {
	return shuffle(WORKFLOW_SUGGESTIONS).slice(0, 6);
});

async function onSuggestionClick(suggestion: WorkflowSuggestion) {
	textInputValue.value = suggestion.prompt;
	await nextTick();
	await new Promise(requestAnimationFrame);
	promptInputRef.value?.focusInput();
}

function onSubmit() {
	if (!textInputValue.value.trim()) return;
	emit('submit', textInputValue.value);
}
</script>

<template>
	<div :class="$style.container">
		<N8nPromptInputSuggestions
			:suggestions="shuffledSuggestions"
			@suggestion-click="onSuggestionClick"
		>
			<template #prompt-input>
				<N8nPromptInput
					ref="promptInputRef"
					v-model="textInputValue"
					:placeholder="i18n.baseText('aiAssistant.builder.assistantPlaceholder')"
					:min-lines="2"
					button-label="Build workflow"
					data-test-id="empty-state-builder-prompt-input"
					autofocus
					@submit="onSubmit"
				/>
			</template>
		</N8nPromptInputSuggestions>
	</div>
</template>

<style lang="scss" module>
.container {
	display: flex;
	justify-content: center;
	align-items: center;
	width: 100%;
	padding: var(--spacing--lg);
}
</style>
