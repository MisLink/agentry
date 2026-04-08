/**
 * Questionnaire types — shared between the tool and the TUI component.
 */

export interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

export interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
	multiSelect: boolean;
	defaultValue?: string;
}

export interface Answer {
	id: string;
	/** Stringified value(s). For multi-select, values are joined with ", ". */
	value: string;
	/** Display-friendly label(s). */
	label: string;
	wasCustom: boolean;
	/** 1-based indices for selected options (undefined for custom answers). */
	indices?: number[];
}

export interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}
