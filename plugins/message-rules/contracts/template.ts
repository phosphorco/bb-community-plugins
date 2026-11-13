export function fixtureTemplate(id: string) {
  return `---\nversion: 1\nid: ${id}\nsender_title: null\ndestination_title: null\nexpect: allow\nrule_catalog: global\nexpected_rules: []\n---\n\n# Message\nWrite the message to check.\n\n# Sender context\n\n# Destination context\n`;
}
