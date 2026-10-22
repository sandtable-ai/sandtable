---
type: regex
target: trace
# Learning what the CLI supports from sandtable's own code instead of --help and validate: any command, path or
# search that touches npx's cache or the project's node_modules/sandtable-ai (cd-ing into it included), except
# reading its package.json for the version. Escaped quotes in a command (grep "bedrock" …) don't end the match.
pattern: '"(command|file_path|path|pattern)":"(?:[^"\\]|\\.)*(\.npm/_npx|node_modules/sandtable-ai(?!/package\.json))'
match: not_contains
---
