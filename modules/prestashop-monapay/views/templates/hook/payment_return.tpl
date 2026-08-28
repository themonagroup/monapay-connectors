<section class="monapay-payment">
  <h3>{l s='Thanh toán MONA Pay VietQR' mod='monapay'}</h3>
  {if $monapay_error}
    <p class="alert alert-warning">{$monapay_error|escape:'htmlall':'UTF-8'}</p>
  {else}
    <p>{l s='Mở ứng dụng ngân hàng và dùng chức năng quét QR.' mod='monapay'}</p>
    <label for="monapay-qr-payload">{l s='Chuỗi VietQR (EMVCo)' mod='monapay'}</label>
    <textarea id="monapay-qr-payload" rows="4" class="form-control" readonly>{$monapay_qr_payload|escape:'htmlall':'UTF-8'}</textarea>
    <p>{l s='Số tài khoản ảo:' mod='monapay'} {$monapay_va|escape:'htmlall':'UTF-8'}</p>
    {* TODO: kiểm với theme/renderer QR PrestaShop đang dùng; qr_data_url không phải URL ảnh. *}
  {/if}
</section>
