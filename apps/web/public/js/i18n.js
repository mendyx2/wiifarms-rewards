// Languages for the player app: English and Hausa.
//
// Screens are written in English; every piece of text passes through tr() on
// its way to the screen. In Hausa, tr() looks the English up in the dictionary
// below, first as an exact phrase and then as a pattern in which {0}, {1}, …
// stand for the parts that change (amounts, dates, counts). Values coming from
// the server — prize names, cycle names, people's names — are shown as they are.
//
// THE HAUSA TEXT NEEDS REVIEW by a fluent speaker, ideally from Niger State,
// before launch — especially anything about money, prizes and play limits.
//
// In Hausa mode, any English text that has no translation is recorded in
// window.__i18nMissing, so tests can make sure nothing is left out.

const STORE = "lang";
let current = (() => {
  try { const v = localStorage.getItem(STORE); if (v === "en" || v === "ha") return v; } catch { /* storage unavailable */ }
  return (navigator.language || "").toLowerCase().startsWith("ha") ? "ha" : "en";
})();

export const lang = () => current;
/** Whether the language was chosen on this phone (rather than guessed from the phone's settings). */
export const chosenHere = () => { try { return localStorage.getItem(STORE) !== null; } catch { return false; } };
export function setLang(l) {
  current = l === "ha" ? "ha" : "en";
  try { localStorage.setItem(STORE, current); } catch { /* storage unavailable */ }
  document.documentElement.lang = current;
}
document.documentElement.lang = current;

const HA = {
  // --- Frame and navigation ---
  "WiiFarm Rewards": "WiiFarm Rewards",
  "Home": "Gida", "My cards": "Katuna na", "Winnings": "Kuɗin nasara", "Draw": "Zaɓe", "Me": "Ni",
  "Messages": "Saƙonni", "SIMULATION · NO REAL MONEY": "GWAJI · BABU KUƊI NA GASKE",
  "Loading…": "Ana lodawa…", "Something went wrong": "Wani abu ya faru ba daidai ba", "Try again": "Sake gwadawa",
  "Something went wrong. Please try again.": "Wani abu ya faru ba daidai ba. Da fatan a sake gwadawa.",
  "Please try again.": "Da fatan a sake gwadawa.", "Please sign in again.": "Da fatan a sake shiga.",
  "No connection. Check your network and try again — nothing was lost.": "Babu haɗi. Duba hanyar sadarwarka ka sake gwadawa — babu abin da ya ɓace.",
  "Access Bank": "Access Bank", "First Bank": "First Bank", "GTBank": "GTBank", "Zenith Bank": "Zenith Bank",
  "Language": "Harshe", "English": "English", "Hausa": "Hausa",
  "Messages, {0} unread": "Saƙonni, {0} ba a karanta ba",
  "Wallet": "Jakar kuɗi",

  // --- Sharing, invites, pop-ups and achievements ---
  "Sales close in": "Sayarwa za ta rufe cikin", "Final draw in": "Zaɓen ƙarshe cikin",
  "{0} day {1}": "kwana {0} {1}", "{0} days {1}": "kwana {0} {1}",
  "just now": "yanzu-yanzu", "{0} min ago": "minti {0} da suka wuce", "{0} h ago": "awa {0} da suka wuce",
  "🔥 {0} cards sold in the last hour": "🔥 An sayar da kati {0} cikin awa ɗayan da ta wuce", "🎉 {0} won": "🎉 An ci {0}",
  "🤝 Invite friends, earn {0}%": "🤝 Gayyaci abokai, ka sami {0}%",
  "Every time a friend you invited buys cards, part of it goes into your wallet.": "Duk lokacin da abokin da ka gayyata ya sayi katuna, wani kaso yana shiga jakarka.",
  "More cards, more chances: each card is one entry in the final draw.": "Ƙarin katuna, ƙarin dama: kowane kati shigarwa ɗaya ne a zaɓen ƙarshe.",
  "Share": "Raba", "Copy link": "Kwafi mahaɗi", "Link copied.": "An kwafi mahaɗi.",
  "WhatsApp": "WhatsApp", "Facebook": "Facebook", "X": "X", "Telegram": "Telegram",
  "Join me on WiiFarm Rewards: ₦500 scratch cards with instant cash prizes, and every card goes into the final draw. Use my invite code {0}. 18+ only. Play responsibly.":
    "Ku zo mu yi WiiFarm Rewards tare: katin karce na ₦500 masu kyaututtukan kuɗi nan take, kuma kowane kati yana shiga zaɓen ƙarshe. Yi amfani da lambar gayyatata {0}. Shekara 18 zuwa sama kawai. Ku yi wasa cikin hankali.",
  "I just won {0} on a WiiFarm Rewards scratch card! Join with my invite code {1}. 18+ only. Play responsibly.":
    "Yanzu na ci {0} a katin karce na WiiFarm Rewards! Ka shiga da lambar gayyatata {1}. Shekara 18 zuwa sama kawai. Ku yi wasa cikin hankali.",
  "Invite friends": "Gayyaci abokai", "Invite friends, earn {0}%": "Gayyaci abokai, ka sami {0}%",
  "Every time a friend you invited buys cards, {0}% of what they pay goes into your wallet. Withdraw it (from ₦500) or use it to buy cards.":
    "Duk lokacin da abokin da ka gayyata ya sayi katuna, {0}% na abin da ya biya yana shiga jakarka. Ka cire shi (daga ₦500) ko ka sayi katuna da shi.",
  "Your invite code": "Lambar gayyatarka", "Your invites": "Gayyatarka",
  "friends joined": "abokan da suka shiga", "friends bought cards": "abokan da suka sayi katuna", "cards they bought": "katunan da suka saya", "earned": "abin da ka samu",
  "Purchase refunded — taken back": "An mayar da kuɗin sayayya — an karɓe", "A friend bought {0} cards": "Aboki ya sayi kati {0}",
  "How it works": "Yadda yake aiki",
  "Your friend signs up with your link or code. They must be 18 or over and verified to buy.": "Abokinka zai yi rajista da mahaɗinka ko lambarka. Dole ya kai shekara 18 kuma a tabbatar da shi kafin ya saya.",
  "You earn on every purchase they make. Only the friends you invite count, not people they invite.": "Kana samun kaso a duk sayayyar da suka yi. Abokan da kai ka gayyata ne kawai ake ƙirga, ba waɗanda su suka gayyata ba.",
  "If a purchase is refunded, its earnings are taken back.": "Idan aka mayar da kuɗin wata sayayya, za a karɓe ladanta.",
  "Please share responsibly: only with adults, and never pressure anyone to play.": "Da fatan ka raba cikin hankali: ga manya kawai, kuma kada ka matsa wa kowa ya yi wasa.",
  "Share your win": "Raba nasararka", "Show me": "Nuna min", "Close": "Rufe",
  "{0}% of the cards are sold": "An sayar da {0}% na katunan",
  "{0} cards are left. The final draw is on {1}.": "Kati {0} ne suka rage. Zaɓen ƙarshe zai kasance a {1}.",
  "Achievements": "Nasarori", "{0} — not yet": "{0} — ba tukuna",
  "Verified": "An tabbatar", "First card": "Kati na farko", "First scratch": "Karcewa ta farko", "Instant win": "Nasara nan take", "Shared": "An raba", "A friend joined": "Aboki ya shiga",

  // --- Invites, wallet and paying from it ---
  "You were invited by a friend. Their code is filled in below.": "Aboki ne ya gayyace ka. An cike lambar gayyatarsa a ƙasa.",
  "Have an invite code?": "Kana da lambar gayyata?", "Invite code (optional)": "Lambar gayyata (ba dole ba)",
  "Wallet balance": "Kuɗin da ke cikin jaka",
  "Your winnings and referral earnings. Withdraw them to a bank account in your own verified name, or use them to buy cards.": "Kuɗin nasararka da ladan gayyata. Ka cire su zuwa asusun banki da ke da sunanka da aka tabbatar, ko ka sayi katuna da su.",
  "Buy cards from my wallet": "Sayi katuna daga jakata",
  "Referral earnings": "Ladan gayyata", "Referral earnings taken back": "An karɓe ladan gayyata", "Cards bought": "An sayi katuna", "Refund": "Mayar da kuɗi", "Adjustment": "Gyara",
  "Pay {0} from my wallet ({1})": "Biya {0} daga jakata ({1})",
  "Pay from your wallet": "Biya daga jakarka", "Wallet balance after": "Saura a jaka bayan biya", "Confirm and buy": "Tabbatar ka saya",
  "Paid from your wallet — your cards are ready.": "An biya daga jakarka — katunanka sun shirya.",
  "Your wallet does not have enough for these cards.": "Babu isasshen kuɗi a jakarka don waɗannan katunan.",
  "Those cards sold out just now. Nothing was taken from your wallet.": "An sayar da katunan yanzu-yanzu. Ba a cire komai daga jakarka ba.",
  "That invite code is not recognised. Check it, or leave it empty.": "Ba a gane wannan lambar gayyata ba. Ka duba ta, ko ka bar wurin babu komai.",

  // --- Home ---
  "On sale": "Ana sayarwa", "Opening soon": "Za a buɗe nan ba da daɗewa ba", "Sales closed": "An rufe sayarwa",
  "Draw complete": "An gama zaɓe", "Finished": "An gama", "Cancelled": "An soke",
  "{0} · {1}": "{0} · {1}",
  "per scratch card": "kowane katin karce",
  "{0} of {1} cards left": "Saura kati {0} cikin {1}",
  "cards win instant cash": "na katuna suna cin kuɗi nan take",
  "1 in {0}": "1 cikin {0}",
  "instant prizes": "kyaututtukan nan take",
  "or when sold out": "ko idan an sayar da duka",
  "Final draw": "Zaɓen ƙarshe",
  "Buy scratch cards": "Sayi katin karce",
  "Sales closed — see the draw": "An rufe sayarwa — duba zaɓen",
  "See the draw": "Duba zaɓen",
  "Try a free demo card": "Gwada katin gwaji kyauta",
  "Final-draw prizes": "Kyaututtukan zaɓen ƙarshe",
  "Every card you buy is entered automatically, win or lose.": "Duk katin da ka saya ana saka shi a zaɓen ƙarshe kai tsaye, ko ka ci ko ba ka ci ba.",
  "Instant prizes": "Kyaututtukan nan take",
  "{0} of {1} cards": "kati {0} cikin {1}",
  "Why you can trust it": "Me yasa za ka amince da shi",
  "Results fixed before sale": "An tsayar da sakamako kafin sayarwa",
  "Scratching only reveals what is already set.": "Karcewa tana nuna abin da aka riga aka tsayar ne kawai.",
  "Check every card yourself": "Ka duba kowane kati da kanka",
  "Your phone checks each result against the fingerprint below.": "Wayarka tana duba kowane sakamako da hatimin tabbatarwa da ke ƙasa.",
  "Independent auditor at the draw": "Mai binciken kuɗi mai zaman kansa yana halartar zaɓe",
  "Anyone can re-run the draw afterwards.": "Kowa zai iya sake gudanar da zaɓen bayan haka.",
  "Published fingerprint": "Hatimin tabbatarwa da aka wallafa",
  "cards: {0}": "katuna: {0}", "prize table: {0}": "jadawalin kyaututtuka: {0}",
  "draw secret (sealed): {0}": "sirrin zaɓe (an rufe): {0}", "published {0}": "an wallafa {0}",
  "Other cycles": "Sauran zagaye",
  "18+ only. Play within your limits. This is a simulation: no real money is taken or paid.": "Shekara 18 zuwa sama kawai. Ka yi wasa cikin iyakarka. Wannan gwaji ne: ba a karɓa ko biyan kuɗi na gaske.",
  "No prize cycle is open right now. Please check back soon.": "Babu zagayen kyauta a buɗe yanzu. Da fatan a sake dubawa nan ba da daɗewa ba.",
  "No prize cycle yet.": "Babu zagayen kyauta tukuna.",
  "This cycle was cancelled. Every card was refunded in full to the payment it came from. Instant prizes already revealed have been kept.": "An soke wannan zagaye. An mayar da kuɗin kowane kati gaba ɗaya ta hanyar da aka biya. Kyaututtukan nan take da aka riga aka bayyana suna nan a hannunka.",
  "🎉 You have {0} to claim": "🎉 Kana da {0} da za ka karɓa",

  // --- Sign-up and sign-in ---
  "Create your account": "Buɗe asusunka", "Just your phone number to start.": "Lambar wayarka kawai za a fara da ita.",
  "Phone number": "Lambar waya", "Send code": "Aika lamba", "Create account": "Buɗe asusu",
  "Enter the 6-digit code": "Shigar da lamba mai haruffa 6", "Choose a 6-digit PIN": "Zaɓi PIN mai haruffa 6",
  "Avoid easy PINs like 111111 or 123456.": "Ka guji PIN masu sauƙi kamar 111111 ko 123456.",
  "Simulation: your code is {0}. In the live service it arrives by SMS.": "Gwaji: lambarka ita ce {0}. A sabis na gaske za ta zo ta SMS.",
  "We sent a code by SMS.": "Mun aika lamba ta SMS.",
  "Already have an account? ": "Kana da asusu tuni? ", "Sign in": "Shiga",
  "New here, or forgot your PIN? ": "Sabon shigowa ne, ko ka manta PIN ɗinka? ", "Use your phone number": "Yi amfani da lambar wayarka",
  "PIN": "PIN",

  // --- Verification ---
  "Confirm it's you": "Tabbatar cewa kai ne",
  "We must check you are 18 or over and in Niger State before you can buy.": "Dole mu tabbatar cewa shekarunka 18 ko sama kuma kana Jihar Neja kafin ka saya.",
  "Verify with": "Tabbatar da", "Number (11 digits)": "Lamba (haruffa 11)",
  "Simulation: in the live service your name, date of birth and location come from the identity check and your phone — you would not type them.": "Gwaji: a sabis na gaske sunanka, ranar haihuwarka da wurinka suna fitowa daga binciken shaidar zama ɗan ƙasa da wayarka — ba za ka rubuta su ba.",
  "Full name": "Cikakken suna", "Date of birth": "Ranar haihuwa", "Where you are": "Inda kake",
  "Niger State": "Jihar Neja", "Lagos State (not yet available)": "Jihar Legas (ba a samu ba tukuna)",
  "Add next of kin (optional now, needed for big prizes)": "Ƙara magaji (ba dole ba yanzu, ana bukata don manyan kyaututtuka)",
  "Relationship": "Dangantaka", "e.g. Sister": "misali Ƙanwa", "Phone": "Waya",
  "Verify and continue": "Tabbatar ka ci gaba", "Verified — you can buy cards now.": "An tabbatar — yanzu za ka iya sayen katuna.",

  // --- Buying ---
  "How many cards?": "Katuna nawa?", "Fewer": "Rage", "More": "Ƙara", "Total": "Jimla",
  "Spent in the last 24 hours": "Abin da aka kashe cikin awa 24 da suka wuce",
  "{0} of {1}": "{0} cikin {1}", "Change my limits": "Canja iyakokina",
  "You are taking a break from play, so buying is switched off.": "Kana hutu daga wasa, don haka an kashe saye.",
  "You have reached your spending limit for now.": "Ka kai iyakar kashe kuɗinka a yanzu.",
  "You can buy up to {0} more within your spending limit.": "Za ka iya sayen ƙarin kati {0} cikin iyakar kashe kuɗinka.",
  "Pay {0}": "Biya {0}",
  "Cards today": "Katunan yau",
  "You have bought today's maximum of {0} cards. You can buy more tomorrow.": "Ka sayi iyakar katunan yau, kati {0}. Za ka iya sayen ƙari gobe.",
  "You can buy {0} more cards today.": "Za ka iya sayen ƙarin kati {0} a yau.",
  "You can buy {0} more cards today (at most {1} a day).": "Za ka iya sayen ƙarin kati {0} a yau (mafi yawa {1} a rana).",
  "You have bought the most cards allowed in one day ({0}). You can buy more tomorrow.": "Ka sayi iyakar katunan da aka yarda a rana ɗaya ({0}). Za ka iya sayen ƙari gobe.",
  "Sales are closed": "An rufe sayarwa",
  "Simulated payment. No real money is taken. In the live service you would pay here by card, bank transfer or USSD.": "Biyan gwaji. Ba a karɓar kuɗi na gaske. A sabis na gaske za ka biya a nan da kati, tura kuɗi ta banki ko USSD.",
  "Confirm simulated payment": "Tabbatar da biyan gwaji", "Cancel": "Soke",
  "Payment confirmed — your cards are ready.": "An tabbatar da biya — katunanka sun shirya.",
  "Refunded in full": "An mayar da kuɗi gaba ɗaya",
  "Those cards sold out while you were paying, so no cards were issued and your payment has been refunded.": "An sayar da katunan yayin da kake biya, don haka ba a ba ka kati ba kuma an mayar maka da kuɗinka.",
  "Back to home": "Koma gida",
  "We could not confirm that payment yet. Please try again.": "Ba mu iya tabbatar da wannan biyan ba tukuna. Da fatan a sake gwadawa.",

  // --- Cards ---
  "You have no cards yet.": "Ba ka da kati tukuna.", "Reveal all": "Bayyana duka", "All cards revealed.": "An bayyana duk katuna.",
  "{0} · {1} to scratch": "{0} · {1} ba a karce ba", "Earlier cycle": "Zagayen baya",
  "Tap to scratch": "Taɓa don karcewa", "No instant win": "Babu nasara nan take", "Won {0}": "Ka ci {0}",
  "In final draw ✓": "Yana cikin zaɓen ƙarshe ✓", "Price refunded": "An mayar da kuɗin kati",
  "Price refunded · {0} prize": "An mayar da kuɗin kati · kyautar {0}",
  "Buy more cards": "Sayi ƙarin katuna",
  "Card not found": "Ba a sami katin ba", "← My cards": "← Katuna na",
  "Your result": "Sakamakonka", "Scratch to reveal": "Karce don ganin sakamako", "Card {0}": "Kati {0}", "Card ": "Kati ",
  "Scratch here": "Karce nan", "Reveal now": "Bayyana yanzu",
  "Scratch surface. Use the Reveal now button if you prefer.": "Wurin karcewa. Yi amfani da maɓallin Bayyana yanzu idan ka fi so.",
  "You won": "Ka ci", "Added to your winnings": "An ƙara a kuɗin nasararka",
  "Added to your wallet": "An ƙara a jakarka", "Tap Accept to add it to your wallet": "Taɓa Karɓa don ƙara shi a jakarka",
  "Accept {0}": "Karɓa {0}", "{0} added to your wallet.": "An ƙara {0} a jakarka.",
  "Accept all winnings ({0})": "Karɓi duk kuɗin nasara ({0})", "Tap to accept": "Taɓa don karɓa",
  "🎉 You have {0} in winnings to accept": "🎉 Kana da {0} na kuɗin nasara da za ka karɓa", "Demo only — nothing is paid": "Gwaji kawai — ba a biyan komai",
  "Still in the final draw": "Har yanzu yana cikin zaɓen ƙarshe", "Demo card": "Katin gwaji",
  "You won {0}!": "Ka ci {0}!",
  "Entered in the final draw": "An saka a zaɓen ƙarshe", "{0} · this card is in, win or lose": "{0} · wannan katin yana ciki, ko ya ci ko bai ci ba",
  "Checked on your phone": "An duba a wayarka", "It matches the fingerprint published before sales opened.": "Ya dace da hatimin tabbatarwa da aka wallafa kafin a buɗe sayarwa.",
  "This result could not be verified": "Ba a iya tabbatar da wannan sakamakon ba", "Please contact support and quote the card number.": "Da fatan a tuntuɓi masu taimako ka faɗi lambar katin.",
  "Show the proof": "Nuna shaida", "card: {0}": "kati: {0}", "result: {0}": "sakamako: {0}", "salt: {0}": "gishiri: {0}",
  "position {0}, {1} proof steps": "matsayi {0}, matakan shaida {1}", "fingerprint: {0}": "hatimi: {0}",
  "Next card": "Kati na gaba", "Back to my cards": "Koma katuna na",
  "Cancelled card": "Katin da aka soke", "See my purchases": "Duba sayayyata",
  "This card was cancelled and its price refunded to the payment it came from. A cancelled card is not in the final draw.": "An soke wannan katin kuma an mayar da kuɗinsa ta hanyar da aka biya. Katin da aka soke ba ya cikin zaɓen ƙarshe.",
  "It had revealed an instant prize of {0}.": "Ya riga ya bayyana kyautar nan take ta {0}.", "It had been scratched: no instant win.": "An riga an karce shi: babu nasara nan take.",
  "Practice only. Demo cards are free, are not entered in the draw and cannot win anything.": "Gwaji kawai. Katin gwaji kyauta ne, ba a saka shi a zaɓe kuma ba zai ci komai ba.",
  "That is how it works. On a real card the result is fixed before you buy, and your phone checks it against the published fingerprint.": "Haka yake aiki. A katin gaske an tsayar da sakamako kafin ka saya, kuma wayarka tana duba shi da hatimin tabbatarwa da aka wallafa.",
  "Try another demo card": "Gwada wani katin gwaji",

  // --- Winnings and prizes ---
  "Available to withdraw": "Abin da za a iya cirewa", "Paid only to a bank account in your own verified name.": "Ana biya ne kawai zuwa asusun banki da ke da sunanka da aka tabbatar.",
  "A purchase of yours was refunded after you had withdrawn {0} that its cards had won. That prize was forfeited, so this amount is owed back; new winnings will go towards it first. Our team will contact you.": "An mayar da kuɗin wata sayayyarka bayan ka riga ka cire {0} da katunanta suka ci. An ƙwace wannan kyautar, don haka ana bin ka wannan kuɗin; sabon kuɗin nasara zai fara biyan shi. Ma'aikatanmu za su tuntuɓe ka.",
  "Verify your identity": "Tabbatar da shaidarka", "Withdraw to bank": "Cire kuɗi zuwa banki", "Amount (₦)": "Adadi (₦)", "To": "Zuwa",
  "Your PIN": "PIN ɗinka", "Withdraw": "Cire",
  "Withdrawal sent to your bank.": "An tura kuɗin zuwa bankinka.",
  "Withdrawal received. Larger amounts are checked by a second person before they are sent.": "An karɓi buƙatar cirewa. Manyan kuɗi wani mutum na biyu yana duba su kafin a tura.",
  "The minimum withdrawal is ₦500.": "Mafi ƙarancin cirewa ₦500 ne.",
  "Bank": "Banki", "Account number (10 digits)": "Lambar asusu (haruffa 10)",
  "Simulation: the live service asks the bank for the account name. Here you type it; it must match your verified name.": "Gwaji: sabis na gaske yana tambayar banki sunan asusun. A nan kai ne za ka rubuta shi; dole ya dace da sunanka da aka tabbatar.",
  "Account name": "Sunan asusu", "Add bank account": "Ƙara asusun banki", "Add another bank account": "Ƙara wani asusun banki", "Add your bank account": "Ƙara asusun bankinka",
  "Bank account added.": "An ƙara asusun banki.", "That account is not in your verified name, so it cannot receive winnings.": "Wannan asusun ba da sunanka da aka tabbatar yake ba, don haka ba zai karɓi kuɗin nasara ba.",
  "History": "Tarihi", "Nothing yet.": "Babu komai tukuna.", "Withdrawals": "Cirewa",
  "Instant win": "Nasara nan take", "Final-draw prize": "Kyautar zaɓen ƙarshe", "Withdrawal": "Cirewa", "Withdrawal returned": "An mayar da kuɗin cirewa",
  "Sent to your bank": "An tura zuwa bankinka", "Being checked": "Ana dubawa", "Not sent — money returned": "Ba a tura ba — an mayar da kuɗi",
  "Processing": "Ana aiki a kai", "On its way": "Yana kan hanya", "Failed": "Bai yi nasara ba",
  "My prizes": "Kyaututtuka na", "Ready to claim": "A shirye don karɓa", "Being reviewed": "Ana nazari", "Claimed — being prepared": "An karɓa — ana shiryawa",
  "Received": "An karɓa", "Claim period ended": "Lokacin karɓa ya ƙare", "Not available": "Babu", "Passed to you as next of kin": "An ba ka a matsayin magaji",
  "{0} · card {1}": "{0} · kati {1}",
  "Add your next of kin before claiming this prize.": "Ƙara magajinka kafin ka karɓi wannan kyautar.", "Add next of kin": "Ƙara magaji",
  "Enter the delivery address.": "Shigar da adireshin kai kaya.",
  "Prize claimed. We will tell you when it is on its way.": "An karɓi kyautar. Za mu sanar da kai idan tana kan hanya.",
  "Your claim is being reviewed. We will be in touch.": "Ana nazarin buƙatarka. Za mu tuntuɓe ka.",
  "Claim within {0} day (by {1}).": "Ka karɓa cikin kwana {0} (kafin {1}).", "Claim within {0} days (by {1}).": "Ka karɓa cikin kwana {0} (kafin {1}).",
  "How would you like it?": "Yaya kake so?", "Deliver it to me": "A kawo min", "I will collect it": "Zan je in karɓa",
  "Delivery address": "Adireshin kai kaya", "House, street, town": "Gida, titi, gari", "Claim my prize": "Karɓi kyautata", "Claim this prize": "Karɓi wannan kyautar",
  "With {0}{1}, to {2}.": "Yana hannun {0}{1}, zuwa {2}.", "the carrier": "mai jigilar kaya",
  "Ready for you to collect.": "A shirye kake ka zo ka karɓa.", "Ready for you to collect at {0}.": "A shirye kake ka zo ka karɓa a {0}.",
  "Your handover code. Give it only to the person handing you the prize, when you have it in your hands.": "Lambar karɓa naka. Ka ba da ita ga mai kawo maka kyautar kawai, idan kyautar tana hannunka.",
  "Received {0}": "An karɓa {0}", "Received {0} · serial {1}": "An karɓa {0} · lamba {1}",
  "Received {0} · serial {1} · {2}-month warranty": "An karɓa {0} · lamba {1} · garanti na wata {2}", "Received {0} · {1}-month warranty": "An karɓa {0} · garanti na wata {1}",
  "We are preparing your delivery to {0}.": "Muna shirya kai maka kaya zuwa {0}.", "We are getting it ready for collection.": "Muna shirya shi don ka zo ka karɓa.",

  // --- Draw ---
  "Draw complete": "An gama zaɓe", "Scheduled · {0}": "An tsara · {0}", "Your entries in {0}: ": "Shigarka a {0}: ", "Your entries in ": "Shigarka a ",
  "The draw runs on this date even if some cards are unsold. Only cards that were bought take part.": "Ana yin zaɓen a wannan rana ko da ba a sayar da wasu katuna ba. Katunan da aka saya ne kawai suke shiga.",
  "How we keep it fair": "Yadda muke tabbatar da adalci",
  "A secret was sealed and its fingerprint published before sales opened.": "An rufe wani sirri kuma an wallafa hatiminsa kafin a buɗe sayarwa.",
  "It is combined with public randomness ({0}, round {1}) that nobody can know in advance.": "Ana haɗa shi da bazuwar jama'a ({0}, zagaye {1}) wadda babu wanda zai iya sani kafin lokaci.",
  "Two staff and the independent auditor must sign before it runs — once only.": "Ma'aikata biyu da mai binciken kuɗi mai zaman kansa dole su sa hannu kafin a gudanar — sau ɗaya kawai.",
  "Afterwards your phone can re-run the whole draw here.": "Bayan haka wayarka za ta iya sake gudanar da zaɓen duka a nan.",
  "Winning cards": "Katunan da suka ci", "Yours!": "Naka ne!", "You won — see your prizes": "Ka ci — duba kyaututtukanka",
  "Check the draw yourself": "Ka duba zaɓen da kanka", "Your phone re-runs the draw over all {0} entries using the published data.": "Wayarka tana sake gudanar da zaɓen a kan duka shigarwa {0} da bayanan da aka wallafa.",
  "Verify the draw": "Tabbatar da zaɓen",
  "Verified: the published winners are exactly what the rules produce.": "An tabbatar: masu nasara da aka wallafa daidai suke da abin da dokoki suka bayar.",
  "The published result does not match. Please report this.": "Sakamakon da aka wallafa bai dace ba. Da fatan a kai rahoto.",
  "The secret is the one committed before sales opened": "Sirrin shi ne wanda aka rufe kafin a buɗe sayarwa",
  "The list of {0} entries matches its published fingerprint": "Jerin shigarwa {0} ya dace da hatiminsa da aka wallafa",
  "The draw seed comes from that secret and the public randomness": "Tushen zaɓen ya fito daga wannan sirrin da bazuwar jama'a",
  "Re-running the draw gives the same winners": "Sake gudanar da zaɓen yana ba da masu nasara iri ɗaya",
  "Check the whole cycle": "Duba dukan zagayen",
  "Every one of the {0} cards — sold or not — has now been published with its result. Your phone rebuilds the fingerprint published before sales opened and counts every prize.": "Duk kati {0} — an sayar ko ba a sayar ba — an wallafa su tare da sakamakonsu. Wayarka tana sake gina hatimin da aka wallafa kafin sayarwa kuma tana ƙirga kowace kyauta.",
  "Downloaded {0} of {1} cards…": "An sauke kati {0} cikin {1}…",
  "All {0} cards published, in order": "An wallafa duk kati {0}, a jere",
  "They rebuild exactly the fingerprint published before sales opened": "Suna sake gina daidai hatimin da aka wallafa kafin a buɗe sayarwa",
  "Every advertised instant prize was on a card ({0} prizes)": "Kowace kyautar nan take da aka tallata tana kan wani kati (kyauta {0})",
  "{0} instant prize was on cards nobody bought — they were real, just not sold.": "Kyautar nan take {0} tana kan katunan da babu wanda ya saya — ta gaske ce, kawai ba a sayar ba.",
  "{0} instant prizes were on cards nobody bought — they were real, just not sold.": "Kyaututtukan nan take {0} suna kan katunan da babu wanda ya saya — na gaske ne, kawai ba a sayar ba.",
  "Verified: the whole cycle is exactly what was promised before sales opened.": "An tabbatar: dukan zagayen daidai yake da abin da aka yi alkawari kafin a buɗe sayarwa.",
  "Something does not match. Please report this.": "Wani abu bai dace ba. Da fatan a kai rahoto.",
  "There is no final draw.": "Babu zaɓen ƙarshe.",
  "This cycle was cancelled. Every card was refunded in full to the payment it came from. Instant prizes already revealed have been kept. There is no final draw.": "An soke wannan zagaye. An mayar da kuɗin kowane kati gaba ɗaya ta hanyar da aka biya. Kyaututtukan nan take da aka riga aka bayyana suna nan a hannunka. Babu zaɓen ƙarshe.",

  // --- Me ---
  "My account": "Asusuna", "Create an account": "Buɗe asusu", "Phone ending {0}": "Waya mai ƙarewa da {0}",
  "Verified · 18+ · {0}": "An tabbatar · 18+ · {0}", "Not verified yet": "Ba a tabbatar ba tukuna", "Verified": "An tabbatar", "Verify": "Tabbatar",
  "Next of kin": "Magaji", "Not added — needed before a big prize is claimed": "Ba a ƙara ba — ana bukata kafin a karɓi babbar kyauta",
  "Change next of kin": "Canja magaji", "Save next of kin": "Ajiye magaji", "Next of kin saved.": "An ajiye magaji.",
  "Help and support": "Taimako",
  "Play within your limits": "Yi wasa cikin iyakarka",
  "You are on a break until {0}.": "Kana hutu har zuwa {0}.", "You have excluded yourself from play.": "Ka dakatar da kanka daga wasa.",
  "Spending limit": "Iyakar kashe kuɗi", "{0} a day": "{0} a rana",
  "Now: {0} a day · {1} a week · {2} a month. Lowering is instant; raising takes 24 hours.": "Yanzu: {0} a rana · {1} a mako · {2} a wata. Ragewa nan take ne; ƙarawa yana ɗaukar awa 24.",
  "Now: {0} a day · {1} a week · {2} a month. Increase to {3} a day starts {4}. Lowering is instant; raising takes 24 hours.": "Yanzu: {0} a rana · {1} a mako · {2} a wata. Ƙarin zuwa {3} a rana zai fara {4}. Ragewa nan take ne; ƙarawa yana ɗaukar awa 24.",
  "Save limit": "Ajiye iyaka", "Limit updated.": "An sabunta iyaka.", "Increase requested — it starts in 24 hours.": "An nemi ƙari — zai fara cikin awa 24.",
  "Take a 7-day break": "Ɗauki hutun kwana 7", "Exclude myself": "Dakatar da kaina",
  "Take a 7-day break? You will not be able to buy cards until it ends, and it cannot be cancelled.": "Ka ɗauki hutun kwana 7? Ba za ka iya sayen kati ba har ya ƙare, kuma ba za a iya soke shi ba.",
  "7-day break started.": "Hutun kwana 7 ya fara.",
  "Exclude yourself from play? This cannot be undone here.": "Ka dakatar da kanka daga wasa? Ba za a iya mayar da wannan a nan ba.",
  "You are now excluded from buying.": "Yanzu an dakatar da kai daga saye.", "Sign out": "Fita",
  "My purchases ({0})": "Sayayyata ({0})", "Paid": "An biya", "Refunded — {0}": "An mayar da kuɗi — {0}",
  "cycle cancelled": "an soke zagaye", "not eligible to buy": "ba ka cancanci saye ba", "payment disputed": "an yi jayayya kan biya",
  "cards sold out while paying": "katunan sun ƙare yayin biya", "charged twice": "an caje sau biyu", "refunded": "an mayar",

  // --- Inbox ---
  "Wins, payouts, deliveries and account alerts. Important ones also come by text message. We will never ask for your PIN or a code.": "Nasarori, biya, kai kaya da sanarwar asusu. Masu muhimmanci suna zuwa ta saƙon tes ma. Ba za mu taɓa tambayar PIN ɗinka ko wata lamba ba.",
  "No messages yet.": "Babu saƙo tukuna.",

  // --- Support ---
  "Support will never ask for your PIN or a code sent to your phone. Your PIN can only be changed by you, with a code sent to your own phone.": "Masu taimako ba za su taɓa tambayar PIN ɗinka ko lambar da aka aika wayarka ba. Kai kaɗai ne za ka iya canja PIN ɗinka, da lambar da aka aika wayarka.",
  "Worried about how much you play? Lower your limits or take a break on the Me page, or ask us for help here.": "Kana damuwa da yawan wasanka? Rage iyakokinka ko ka ɗauki hutu a shafin Ni, ko ka nemi taimakonmu a nan.",
  "Your reply": "Amsarka", "Send": "Aika", "Sent.": "An aika.",
  "Waiting for support": "Ana jiran masu taimako", "Support replied": "Masu taimako sun amsa", "Closed": "An rufe",
  "WiiFarm support": "Masu taimakon WiiFarm", "You": "Kai",
  "This request is closed. Start a new one below if you need more help.": "An rufe wannan buƙatar. Fara sabuwa a ƙasa idan kana bukatar ƙarin taimako.",
  "Ask for help": "Nemi taimako", "What is it about?": "Game da me ne?", "Subject": "Batu", "Tell us what happened": "Faɗa mana abin da ya faru",
  "Do not include your PIN or any code. If you can, give the card number or the date and amount of the payment.": "Kada ka saka PIN ɗinka ko wata lamba. Idan za ka iya, ka ba da lambar kati ko ranar da adadin biyan.",
  "Sent. We will reply here and send you a text when we do.": "An aika. Za mu amsa a nan kuma mu aiko maka da saƙon tes idan mun amsa.",
  "A payment or refund": "Biya ko mayar da kuɗi", "A prize or withdrawal": "Kyauta ko cirewa", "My account": "Asusuna",
  "Something is not working": "Wani abu baya aiki", "I want to make a complaint": "Ina son yin ƙorafi", "Something else": "Wani abu dabam",

  // --- Offline and installing ---
  "You are offline": "Ba ka da haɗin intanet",
  "WiiFarm Rewards needs a connection to show your cards, results and winnings. Anything you have already bought or won is safe.": "WiiFarm Rewards yana bukatar haɗin intanet don nuna katunanka, sakamako da kuɗin nasararka. Duk abin da ka riga ka saya ko ka ci yana nan lafiya.",
  "This page will update by itself when you are back online.": "Wannan shafin zai sabunta kansa idan haɗinka ya dawo.",
  "Add WiiFarm Rewards to your home screen": "Saka WiiFarm Rewards a allon farko na wayarka",
  "Open it like an app, with one tap. It uses very little space.": "Buɗe shi kamar manhaja, da taɓawa ɗaya. Ba ya ɗaukar wuri da yawa.",
  "Add to home screen": "Saka a allon farko", "Not now": "Ba yanzu ba",
  "In Safari, tap the Share button, then Add to Home Screen.": "A Safari, taɓa maɓallin Share, sannan Add to Home Screen.",

  // --- Server messages (shown to players) ---
  "Wrong phone number or PIN.": "Lambar waya ko PIN ba daidai ba ne.",
  "Too many wrong attempts. Try again in a few minutes or reset your PIN.": "Kuskure ya yi yawa. Sake gwadawa bayan 'yan mintuna ko ka sake saita PIN ɗinka.",
  "Your account is locked for your protection. Please contact support to unlock it.": "An kulle asusunka don kare ka. Da fatan a tuntuɓi masu taimako don buɗe shi.",
  "Enter a valid Nigerian mobile number.": "Shigar da ingantacciyar lambar wayar Najeriya.",
  "Your PIN must be 6 digits.": "Dole PIN ɗinka ya zama haruffa 6.", "Choose a PIN that is harder to guess.": "Zaɓi PIN da ya fi wuyar tsammani.",
  "That code is wrong or has expired. Request a new one.": "Lambar ba daidai ba ce ko ta ƙare. Nemi sabuwa.",
  "Too many codes requested. Please try again in an hour.": "An nemi lambobi da yawa. Da fatan a sake gwadawa bayan awa ɗaya.",
  "We could not send the code just now. Please try again in a minute.": "Ba mu iya aika lambar yanzu ba. Da fatan a sake gwadawa bayan minti ɗaya.",
  "You must be 18 or over to play.": "Dole ne shekarunka su kai 18 ko sama kafin ka yi wasa.",
  "This identity is already linked to another account. Each person can have one account.": "Wannan shaidar an riga an haɗa ta da wani asusu. Kowane mutum asusu ɗaya ne kawai.",
  "Enter the 11-digit number.": "Shigar da lamba mai haruffa 11.",
  "Verify your age and identity before buying.": "Tabbatar da shekarunka da shaidarka kafin ka saya.",
  "This cycle is not available where you are.": "Wannan zagayen ba a samu inda kake ba.",
  "You are not eligible to take part.": "Ba ka cancanci shiga ba.",
  "That would take you over your daily spending limit.": "Wannan zai wuce iyakar kashe kuɗinka na rana.",
  "That would take you over your weekly spending limit.": "Wannan zai wuce iyakar kashe kuɗinka na mako.",
  "That would take you over your monthly spending limit.": "Wannan zai wuce iyakar kashe kuɗinka na wata.",
  "You can hold at most {0} cards in this cycle.": "Mafi yawan kati da za ka riƙe a wannan zagaye {0} ne.",
  "This cycle is sold out.": "An sayar da duk katunan wannan zagaye.", "Only {0} cards are left.": "Kati {0} ne kawai suka rage.",
  "Sales for this cycle are not open.": "Ba a buɗe sayarwar wannan zagaye ba.",
  "Card not found.": "Ba a sami katin ba.", "This card was cancelled.": "An soke wannan katin.",
  "Enter your PIN to confirm.": "Shigar da PIN ɗinka don tabbatarwa.",
  "Winnings can only be paid to a bank account in your own verified name.": "Ana biyan kuɗin nasara ne kawai zuwa asusun banki da ke da sunanka da aka tabbatar.",
  "This bank account was added recently. For your safety it can receive payouts after the waiting period.": "An ƙara wannan asusun banki kwanan nan. Don lafiyarka zai karɓi biya bayan lokacin jira.",
  "You do not have that much to withdraw.": "Ba ka da kuɗi kamar haka da za ka cire.",
  "Bank account not found.": "Ba a sami asusun banki ba.",
  "Verify your identity before adding a bank account.": "Tabbatar da shaidarka kafin ka ƙara asusun banki.",
  "Enter the 10-digit account number.": "Shigar da lambar asusu mai haruffa 10.",
  "Next-of-kin details cannot be changed while a prize claim is in progress.": "Ba za a iya canja bayanan magaji ba yayin da ake karɓar kyauta.",
  "Name and relationship are required.": "Ana bukatar suna da dangantaka.",
  "That is above the maximum limit allowed.": "Wannan ya wuce mafi girman iyakar da aka yarda.",
  "The daily limit cannot exceed the weekly limit, nor the weekly the monthly.": "Iyakar rana ba za ta wuce ta mako ba, haka ma ta mako ba za ta wuce ta wata ba.",
  "This prize has already been claimed or is no longer available.": "An riga an karɓi wannan kyautar ko kuma babu ita yanzu.",
  "The claim period for this prize has ended.": "Lokacin karɓar wannan kyautar ya ƙare.",
  "Add your next of kin before claiming this prize.": "Ƙara magajinka kafin ka karɓi wannan kyautar.",
  "Verify your identity before claiming a prize.": "Tabbatar da shaidarka kafin ka karɓi kyauta.",
  "Prize not found.": "Ba a sami kyautar ba.",
  "Write a message.": "Rubuta saƙo.", "Please keep it under {0} characters.": "Da fatan kada ya wuce haruffa {0}.",
  "You already have several open requests. Please add to one of those, and we will answer it.": "Kana da buƙatu da yawa a buɗe. Da fatan ka ƙara a ɗayansu, za mu amsa.",
  "This request is closed. Please start a new one.": "An rufe wannan buƙatar. Da fatan ka fara sabuwa.",
  "Request not found.": "Ba a sami buƙatar ba.",
  "Some details are missing or not valid. Please check and try again.": "Wasu bayanai sun ɓace ko ba daidai ba ne. Da fatan a duba a sake gwadawa.",
  "Too many requests. Please slow down.": "Buƙatu sun yi yawa. Da fatan a rage gudu.",
  "Not found.": "Ba a samu ba.", "Please sign in.": "Da fatan a shiga.",
  "This account is not available. Please contact support.": "Ba a samun wannan asusun. Da fatan a tuntuɓi masu taimako.",
  "Request refused.": "An ƙi buƙatar.", "Not available.": "Babu.", "Invalid date of birth.": "Ranar haihuwa ba daidai ba ce.", "Name is required.": "Ana bukatar suna.",
  "Limits must be whole amounts of zero or more.": "Dole iyakoki su zama cikakkun adadi na sifili ko sama.",
  "A break can last from 1 to 90 days.": "Hutu zai iya kasancewa daga kwana 1 zuwa 90.", "Self-exclusion lasts at least 6 months.": "Dakatar da kai yana ɗaukar aƙalla wata 6.",
  "We could not allocate your prize automatically. Our team has been alerted and will contact you.": "Ba mu iya ware maka kyautarka kai tsaye ba. An sanar da ma'aikatanmu kuma za su tuntuɓe ka.",
  "This request is closed.": "An rufe wannan buƙatar.", "You can buy 1 to {0} cards at a time.": "Za ka iya sayen kati 1 zuwa {0} a lokaci ɗaya.",
  "Unknown payment.": "Ba a san wannan biyan ba.", "Unknown order.": "Ba a san wannan oda ba.",
  "Missing or invalid Idempotency-Key.": "Wani abu ya faru ba daidai ba. Da fatan a sake gwadawa.",
  "This request key was already used for a different order.": "Wani abu ya faru ba daidai ba. Da fatan a sake gwadawa.",
  "Cards are auto-revealed only after the cycle closes.": "Ana bayyana katuna kai tsaye ne bayan zagayen ya rufe.",
  "This identity is already linked to another account.": "Wannan shaidar an riga an haɗa ta da wani asusu.",
};

// Words that are counted ("5 cards"): Hausa puts the noun first and usually keeps it singular after a number.
const COUNT_HA = {
  card: ["kati", "kati"], "scratch card": ["katin karce", "katin karce"], winner: ["mai nasara", "masu nasara"], prize: ["kyauta", "kyauta"],
};

/** "5 cards" in the current language. */
export function count(n, word) {
  if (current === "ha" && COUNT_HA[word]) return done(`${COUNT_HA[word][n === 1 ? 0 : 1]} ${n}`);
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// Patterns: "Pay {0}" becomes /^Pay (.+?)$/ and the captured parts are put into the Hausa.
const PATTERNS = Object.keys(HA).filter((k) => /\{\d\}/.test(k)).map((k) => {
  const parts = k.split(/\{(\d)\}/);
  let src = "^", order = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) src += parts[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else { src += "(.+?)"; order.push(Number(parts[i])); }
  }
  return { re: new RegExp(src + "$", "s"), order, to: HA[k], fixed: parts.filter((_, i) => i % 2 === 0).join("").length };
}).sort((a, b) => b.fixed - a.fixed); // the most specific pattern wins

const missing = new Set();
// Text that is already in Hausa (made by count() or by an earlier tr()) is not looked up again.
const already = new Set(Object.values(HA));
const done = (t) => { if (already.size < 5000) already.add(t); return t; };
if (typeof window !== "undefined") window.__i18nMissing = missing;

/** The text in the current language. Text with no translation is shown in English (and recorded). */
export function tr(text) {
  if (current !== "ha" || typeof text !== "string" || !/[A-Za-z]/.test(text) || /^https?:\/\/\S+$/.test(text)) return text; // web addresses stay as they are
  if (Object.prototype.hasOwnProperty.call(HA, text)) return HA[text];
  if (already.has(text)) return text;
  for (const p of PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      const vals = []; p.order.forEach((n, i) => { vals[n] = m[i + 1]; });
      return done(p.to.replace(/\{(\d)\}/g, (_, n) => tr(vals[Number(n)])));
    }
  }
  if (/[a-z]{3,}/.test(text)) missing.add(text);
  return text;
}

const MONTHS_HA = ["Janairu", "Fabrairu", "Maris", "Afrilu", "Mayu", "Yuni", "Yuli", "Agusta", "Satumba", "Oktoba", "Nuwamba", "Disamba"];

/** A date and time in the player's language. Hausa uses the 24-hour clock: "30 Nuwamba 2026, 10:17". */
export function formatDate(iso) {
  const d = new Date(iso);
  if (current === "ha") return done(`${d.getDate()} ${MONTHS_HA[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`);
  return d.toLocaleString("en-NG", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });
}
