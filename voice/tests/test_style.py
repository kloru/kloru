from voice.style import StyleMeter


def test_a_brief_caller_hears_about_long_replies_once():
    m = StyleMeter()
    m.caller_said("What's on tomorrow?")
    m.kloru_said("Tomorrow you have drop-off at eight, the dentist at three, and pickup at four thirty, and Cleo works the early shift.")
    m.caller_said("Okay. Email?")
    m.kloru_said("You have three unread emails: an Amazon promotion, the daycare newsletter about dress-up Friday, and Sam asking about Saturday.")
    note = m.note()
    assert note and "about 2 words" in note and "Match them" in note
    assert m.note() is None  # said once
    for _ in range(4):
        m.caller_said("Next.")
        m.kloru_said("Here is a long reply with many words in it that goes on and on for the brief caller again.")
    assert m.note()  # drifted back: said again


def test_a_matched_or_chatty_call_gets_nothing():
    m = StyleMeter()
    for _ in range(3):
        m.caller_said("So I was thinking about the weekend and whether we could go somewhere fun with Nora, maybe a farm.")
        m.kloru_said("Ardenwood Historic Farm is 35 minutes away and has animals and a little train; Tilden's Little Farm is closer.")
    assert m.note() is None
    short = StyleMeter()
    for _ in range(3):
        short.caller_said("Weather?")
        short.kloru_said("Sunny, 70.")
    assert short.note() is None
