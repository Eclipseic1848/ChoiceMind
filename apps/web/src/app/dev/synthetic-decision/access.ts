type SyntheticDevelopmentEnvironment = Readonly<{
	CHOICEMIND_ENABLE_SYNTHETIC_DEV_PAGE?: string;
	NODE_ENV?: string;
}>;

export function isSyntheticDevelopmentPageEnabled(
	environment: SyntheticDevelopmentEnvironment,
): boolean {
	return (
		environment.NODE_ENV === "development" ||
		environment.CHOICEMIND_ENABLE_SYNTHETIC_DEV_PAGE === "true"
	);
}
