#let template(body, title: none, pages: none) = {
  assert(title == "Pilot" and pages == 2)
  set document(title: title + "-" + str(pages))
  body
}
