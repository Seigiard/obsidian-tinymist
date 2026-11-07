#let template(body, title: none, pages: none) = {
  assert(title == "Pilot" and pages == 2)
  [#metadata((title: title, pages: pages)) <template-args>
  #body]
}
