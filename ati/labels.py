"""Label metadata shared by the site, the mark kit, the issue forms and the validators."""

LABELS = {
    "human-authored": {
        "name": "Human Authored",
        "abbr": "HA",
        "form_option": "Human Authored (HA)",
        "color": "#4a5866",       # text / border on light backgrounds
        "color_dark": "#aab6c3",  # text / border on dark backgrounds
        "a_stops": ["#cfd6de", "#76828f", "#3d4752"],
        "ring_stops": ["#b9c2cc", "#5d6874"],
        "short": "No generative AI wrote, rewrote or expanded any of the text.",
        "tagline": "No generative AI wrote the text",
    },
    "ai-master-edited": {
        "name": "AI Master Edited",
        "abbr": "AME",
        "form_option": "AI Master Edited (AME)",
        "color": "#1f5fbf",
        "color_dark": "#78b2ff",
        "a_stops": ["#68adff", "#1f5fbf", "#123f8c"],
        "ring_stops": ["#8ec8ff", "#1f5fbf"],
        "short": "The author originated and directed the work; AI helped edit, revise or check it under the author’s direction and approval.",
        "tagline": "Author directed · Author approved",
    },
    "ai-co-authored": {
        "name": "AI Co-Authored",
        "abbr": "ACA",
        "form_option": "AI Co-Authored (ACA)",
        "color": "#6b3fb5",
        "color_dark": "#b99bf0",
        "a_stops": ["#b08df0", "#6b3fb5", "#43237f"],
        "ring_stops": ["#cdb2f7", "#6b3fb5"],
        "short": "Human and AI together created the expressive content of the work.",
        "tagline": "Human + AI collaboration",
    },
}
LABEL_KEYS = list(LABELS)
OPTION_TO_LABEL = {v["form_option"]: k for k, v in LABELS.items()}

# Non-text components of a work.
PARTS = {
    "cover": "Cover art",
    "interior_art": "Interior illustrations or maps",
    "narration": "Audio narration",
    "translation": "Translation",
}
AI_USE = {
    "na": "Not applicable (no such component)",
    "none": "Human-made, no AI used",
    "assisted": "AI-assisted (human-made; AI used to retouch, upscale, clean up or modify it)",
    "generated": "AI-generated (an AI tool created it; a human directed and selected it)",
}
AI_USE_SHORT = {
    "none": "Human-made",
    "assisted": "AI-assisted",
    "generated": "AI-generated, human-directed",
}
OPTION_TO_AI_USE = {v: k for k, v in AI_USE.items()}

FORMATS = {"ebook": "Ebook", "print": "Print", "audiobook": "Audiobook"}

# Who is making the declaration. The registry does not confirm any of these.
ROLES = {
    "author": "Author of this work",
    "publisher": "Publisher of this work",
    "representative": "Authorized representative of the author or publisher",
}
ROLE_SHORT = {"author": "the author", "publisher": "the publisher", "representative": "an authorized representative"}
OPTION_TO_ROLE = {v: k for k, v in ROLES.items()}
STATUSES = ["active", "disputed", "withdrawn", "removed"]

ATTESTATIONS = {
    "accurate": "The information above is accurate and complete to the best of my knowledge.",
    "rights": ("I have the right to make this declaration for this work, and I have checked that the terms of "
               "each AI tool listed permit use of its outputs in this publication."),
    "self_declared": "I understand this is a self-declaration that the registry does not verify, and that it is not a certification.",
    "terms": "I agree to the Terms and Privacy Policy, and that this record will be published openly under CC0 1.0.",
}


# Full definitions, version 0.1 (draft). Edited here; rendered on /labels/ and on every record page.
# A record shows the version it was declared under, so when a new version is published the old one is
# kept in DEFINITIONS_BY_VERSION and never rewritten.
DEFINITIONS_V01 = {
    "human-authored": {
        "definition": ("The author or authors originated and wrote all of the text. No generative AI wrote, rewrote, "
                       "translated or expanded any of it, and no wording, passage or plot point that an AI generated or "
                       "suggested appears in it."),
        "allowed": [
            "Spelling and grammar checkers that flag problems for the author to fix by hand.",
            "Research, brainstorming or discussion with AI tools, provided nothing the AI generated or suggested (wording, plot, structure) appears in the work.",
            "Speech-to-text dictation, and accessibility, formatting and indexing tools.",
        ],
        "not_allowed": [
            "AI-written or AI-rewritten sentences, passages, summaries or dialogue, including generative grammar or style rewriting.",
            "AI translation of the text.",
            "Ideas, scenes or wording suggested by an AI that the author then used.",
        ],
        "boundary": "Applies to the published text of the work, including front and back matter such as the blurb, dedication and author’s note.",
    },
    "ai-master-edited": {
        "definition": ("The story, ideas and structure originate with the human author, who directed the AI and "
                       "reviewed and approved every change. AI served as editor, researcher, sounding board or "
                       "continuity checker, and may have revised or rewritten the author’s own text under that direction."),
        "allowed": [
            "Line edits, rewrites and tightening of the author’s own draft, directed and approved by the author.",
            "Consistency, continuity and fact checks.",
            "Suggestions that the author accepted, rejected or adapted.",
        ],
        "not_allowed": [
            "New scenes, chapters, characters, plot points or substantial passages that the AI originated rather than the author. Use AI Co-Authored.",
        ],
        "boundary": ("Decide by origination: the author originated the content, and the AI changed how it was expressed. "
                     "If the AI originated passages from a prompt, they are AI-generated even when the task was called “editing”."),
    },
    "ai-co-authored": {
        "definition": ("Human and AI materially collaborated in creating the expressive content: AI originated new "
                       "passages, scenes, chapters or dialogue that appear in the work, with a human directing, "
                       "selecting and editing."),
        "allowed": [
            "AI-generated prose, however heavily the author edited it afterwards.",
            "AI used to draft chapters or scenes from the author’s outline or prompts.",
        ],
        "not_allowed": [],
        "boundary": "Choose this label when AI produced a meaningful share of the sentences, even if the author shaped the whole.",
    },
}
DEFINITIONS_BY_VERSION = {"0.1": DEFINITIONS_V01}
DEFINITIONS = DEFINITIONS_BY_VERSION["0.1"]  # the current version
